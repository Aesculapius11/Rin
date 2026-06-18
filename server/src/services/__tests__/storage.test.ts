import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { BlobService, StorageService } from '../storage';
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Variables, JWTUtils, CacheImpl } from "../../core/hono-types";
import { createMockDB, createMockEnv, cleanupTestDB, TestCacheImpl } from '../../../tests/fixtures';
import type { Database } from 'bun:sqlite';

describe('StorageService', () => {
    let db: any;
    let sqlite: Database;
    let env: Env;
    let app: Hono<{ Bindings: Env; Variables: Variables }>;
    let originalFetch: typeof globalThis.fetch;

    beforeEach(async () => {
        const mockDB = createMockDB();
        db = mockDB.db;
        sqlite = mockDB.sqlite;
        env = createMockEnv();
        originalFetch = globalThis.fetch;

        app = new Hono<{ Bindings: Env; Variables: Variables }>();
        
        // Mock middleware to inject dependencies
        app.use(createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
            c.set('db', db);
            c.set('cache', new TestCacheImpl());
            c.set('serverConfig', new TestCacheImpl());
            c.set('clientConfig', new TestCacheImpl());
            c.set('jwt', {
                sign: async (payload: any) => `mock_token_${payload.id}`,
                verify: async (token: string) => token.startsWith('mock_token_') ? { id: 1 } : null,
            } as JWTUtils);
            c.set('oauth2', undefined);
            c.set('admin', false);
            c.set('env', env);
            c.set('uid', undefined);
            
            await next();
        }));

        // Mount service
        app.route('/', StorageService());
        app.route('/blob', BlobService());

        // Create test user
        await createTestUser();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        cleanupTestDB(sqlite);
    });

    async function createTestUser() {
        sqlite.exec(`
            INSERT INTO users (id, username, openid, avatar, permission) 
            VALUES (1, 'testuser', 'gh_test', 'avatar.png', 1)
        `);
    }

    function createAppWithEnv(appEnv: Env, uid?: number) {
        return createAppWithConfigs(appEnv, uid);
    }

    function createAppWithConfigs(
        appEnv: Env,
        uid?: number,
        serverConfigEntries: Record<string, string> = {},
    ) {
        const serviceApp = new Hono<{ Bindings: Env; Variables: Variables }>();
        serviceApp.use(createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
            c.set('db', db);
            c.set('cache', new TestCacheImpl());
            const serverConfig = new TestCacheImpl();
            for (const [key, value] of Object.entries(serverConfigEntries)) {
                await serverConfig.set(key, value);
            }
            c.set('serverConfig', serverConfig);
            c.set('clientConfig', new TestCacheImpl());
            c.set('jwt', {
                sign: async (payload: any) => `mock_token_${payload.id}`,
                verify: async (token: string) => token.startsWith('mock_token_') ? { id: 1 } : null,
            } as JWTUtils);
            c.set('env', appEnv);
            c.set('uid', uid);
            await next();
        }));
        serviceApp.route('/', StorageService());
        serviceApp.route('/blob', BlobService());
        return serviceApp;
    }

    describe('POST / - Upload file', () => {
        it('should require authentication', async () => {
            const formData = new FormData();
            formData.append('file', new File(['test content'], 'test.txt', { type: 'text/plain' }));
            
            const res = await app.request('/', {
                method: 'POST',
                body: formData,
            }, env);

            // Could be 400 (validation) or 401 (auth)
            expect(res.status).toBeGreaterThanOrEqual(400);
            expect(res.status).toBeLessThanOrEqual(401);
        });

        it('should upload through R2 binding when configured', async () => {
            const putCalls: Array<{ key: string; type: string | undefined }> = [];
            const r2Env = createMockEnv({
                R2_BUCKET: {
                    put: async (key: string, value: any, options?: R2PutOptions) => {
                        putCalls.push({
                            key,
                            type: options?.httpMetadata && 'contentType' in options.httpMetadata
                                ? options.httpMetadata.contentType
                                : undefined,
                        });
                        return {
                            key,
                            version: '1',
                            size: value.size || 0,
                            etag: 'etag',
                            httpEtag: 'etag',
                            uploaded: new Date(),
                            storageClass: 'Standard',
                            checksums: {} as R2Checksums,
                            writeHttpMetadata: () => {},
                        } as unknown as R2Object;
                    },
                } as unknown as R2Bucket,
                S3_ACCESS_HOST: 'https://images.example.com' as any,
                S3_ENDPOINT: '' as any,
                S3_BUCKET: '' as any,
                S3_ACCESS_KEY_ID: '',
                S3_SECRET_ACCESS_KEY: '',
            });

            const r2App = createAppWithEnv(r2Env, 1);
            const formData = new FormData();
            formData.append('key', 'test.txt');
            formData.append('file', new File(['test content'], 'test.txt', { type: 'text/plain' }));

            const res = await r2App.request('/', {
                method: 'POST',
                body: formData,
            }, r2Env);

            expect(res.status).toBe(200);
            expect(putCalls).toHaveLength(1);
            expect(putCalls[0]?.key).toMatch(/^images\/[a-f0-9]+\.txt$/);
            expect(putCalls[0]?.type).toBe('text/plain;charset=utf-8');
            const payload = await res.json() as { url: string };
            expect(payload.url).toMatch(/^https:\/\/images\.example\.com\/images\/[a-f0-9]+\.txt$/);
        });

        it('should return an /api/blob URL when R2 is configured without S3_ACCESS_HOST', async () => {
            const putCalls: string[] = [];
            const r2Env = createMockEnv({
                R2_BUCKET: {
                    put: async (key: string) => {
                        putCalls.push(key);
                        return {
                            key,
                            version: '1',
                            size: 4,
                            etag: 'etag',
                            httpEtag: 'etag',
                            uploaded: new Date(),
                            storageClass: 'Standard',
                            checksums: {} as R2Checksums,
                            writeHttpMetadata: () => {},
                        } as unknown as R2Object;
                    },
                } as unknown as R2Bucket,
                S3_ACCESS_HOST: '' as any,
                S3_ENDPOINT: '' as any,
                S3_BUCKET: '' as any,
                S3_ACCESS_KEY_ID: '',
                S3_SECRET_ACCESS_KEY: '',
            });

            const r2App = createAppWithEnv(r2Env, 1);
            const formData = new FormData();
            formData.append('key', 'test.txt');
            formData.append('file', new File(['test'], 'test.txt', { type: 'text/plain' }));

            const res = await r2App.request('/', {
                method: 'POST',
                body: formData,
            }, r2Env);

            expect(res.status).toBe(200);
            expect(putCalls).toHaveLength(1);

            const payload = await res.json() as { url: string };
            expect(payload.url).toMatch(/^http:\/\/localhost\/api\/blob\/images\/[a-f0-9]+\.txt$/);
        });

        it('should return 500 when S3_ENDPOINT is not defined without R2 binding', async () => {
            const envNoS3 = createMockEnv({
                S3_ENDPOINT: '' as any,
            });
            const appNoS3 = createAppWithEnv(envNoS3, 1);

            const formData = new FormData();
            formData.append('key', 'test.txt');
            formData.append('file', new File(['test content'], 'test.txt', { type: 'text/plain' }));
            
            const res = await appNoS3.request('/', {
                method: 'POST',
                body: formData,
            }, envNoS3);

            expect(res.status).toBe(500);
            expect(await res.text()).toBe('S3_ENDPOINT is not defined');
        });

        it('should return error when S3_ACCESS_KEY_ID is not defined without R2 binding', async () => {
            const envNoKey = createMockEnv({
                S3_ACCESS_KEY_ID: '',
            });
            const appNoKey = createAppWithEnv(envNoKey, 1);

            const formData = new FormData();
            formData.append('key', 'test.txt');
            formData.append('file', new File(['test content'], 'test.txt', { type: 'text/plain' }));
            
            const res = await appNoKey.request('/', {
                method: 'POST',
                body: formData,
            }, envNoKey);

            expect(res.status).toBe(500);
            expect(await res.text()).toBe('S3_ACCESS_KEY_ID is not defined');
        });

        it('should return 500 when imgbed endpoint is missing', async () => {
            const imgbedApp = createAppWithConfigs(env, 1, {
                'storage.provider': 'imgbed',
                'imgbed.api_token': 'secret-token',
            });

            const formData = new FormData();
            formData.append('key', 'test.png');
            formData.append('file', new File(['body'], 'test.png', { type: 'image/png' }));

            const res = await imgbedApp.request('/', {
                method: 'POST',
                body: formData,
            }, env);

            expect(res.status).toBe(500);
            expect(await res.text()).toBe('imgbed.endpoint is not defined');
        });

        it('should upload through CloudFlare-ImgBed and return the direct url', async () => {
            const requests: Array<{ url: string; auth: string | null; fileName: string | null }> = [];
            globalThis.fetch = async (input, init) => {
                const request = new Request(input, init);
                const originalRequest = input instanceof Request ? input : null;
                const body = init?.body;
                const form = body instanceof FormData
                    ? body
                    : originalRequest
                        ? await originalRequest.clone().formData()
                        : await request.formData();
                const file = form.get('file');

                requests.push({
                    url: request.url,
                    auth: request.headers.get('authorization'),
                    fileName: file instanceof File ? file.name : null,
                });

                return Response.json([{ publicUrl: 'https://img.example.com/file/abc.png' }]);
            };

            const imgbedApp = createAppWithConfigs(env, 1, {
                'storage.provider': 'imgbed',
                'imgbed.endpoint': 'https://img.example.com',
                'imgbed.api_token': 'secret-token',
            });

            const formData = new FormData();
            formData.append('key', 'test.png');
            formData.append('file', new File(['body'], 'test.png', { type: 'image/png' }));

            const res = await imgbedApp.request('/', {
                method: 'POST',
                body: formData,
            }, env);

            expect(res.status).toBe(200);
            const payload = await res.json() as { url: string };
            expect(payload.url).toBe('https://img.example.com/file/abc.png');
            expect(requests[0]?.url).toContain('/upload?returnFormat=full');
            expect(requests[0]?.auth).toBe('Bearer secret-token');
            expect(requests[0]?.fileName).toMatch(/^[a-f0-9]+\.png$/);
        });

        it('should return 502 when imgbed returns a non-2xx response', async () => {
            globalThis.fetch = async () => new Response('upstream error', { status: 403 });

            const imgbedApp = createAppWithConfigs(env, 1, {
                'storage.provider': 'imgbed',
                'imgbed.endpoint': 'https://img.example.com',
                'imgbed.api_token': 'secret-token',
            });

            const formData = new FormData();
            formData.append('key', 'test.png');
            formData.append('file', new File(['body'], 'test.png', { type: 'image/png' }));

            const res = await imgbedApp.request('/', {
                method: 'POST',
                body: formData,
            }, env);

            expect(res.status).toBe(502);
            expect(await res.text()).toBe('ImgBed upload failed');
        });

        it('should return 502 when imgbed transport fails', async () => {
            globalThis.fetch = async () => {
                throw new Error('socket hang up');
            };

            const imgbedApp = createAppWithConfigs(env, 1, {
                'storage.provider': 'imgbed',
                'imgbed.endpoint': 'https://img.example.com',
                'imgbed.api_token': 'secret-token',
            });

            const formData = new FormData();
            formData.append('key', 'test.png');
            formData.append('file', new File(['body'], 'test.png', { type: 'image/png' }));

            const res = await imgbedApp.request('/', {
                method: 'POST',
                body: formData,
            }, env);

            expect(res.status).toBe(502);
            expect(await res.text()).toBe('ImgBed upload failed');
        });

        it('should return 502 when imgbed returns malformed json', async () => {
            globalThis.fetch = async () => new Response('not json', {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });

            const imgbedApp = createAppWithConfigs(env, 1, {
                'storage.provider': 'imgbed',
                'imgbed.endpoint': 'https://img.example.com',
                'imgbed.api_token': 'secret-token',
            });

            const formData = new FormData();
            formData.append('key', 'test.png');
            formData.append('file', new File(['body'], 'test.png', { type: 'image/png' }));

            const res = await imgbedApp.request('/', {
                method: 'POST',
                body: formData,
            }, env);

            expect(res.status).toBe(502);
            expect(await res.text()).toBe('ImgBed upload failed');
        });

        it('should fall back to src when publicUrl is absent', async () => {
            globalThis.fetch = async () => Response.json([{ src: 'https://img.example.com/file/fallback.png' }]);

            const imgbedApp = createAppWithConfigs(env, 1, {
                'storage.provider': 'imgbed',
                'imgbed.endpoint': 'https://img.example.com',
                'imgbed.api_token': 'secret-token',
            });

            const formData = new FormData();
            formData.append('key', 'test.png');
            formData.append('file', new File(['body'], 'test.png', { type: 'image/png' }));

            const res = await imgbedApp.request('/', {
                method: 'POST',
                body: formData,
            }, env);

            expect(res.status).toBe(200);
            const payload = await res.json() as { url: string };
            expect(payload.url).toBe('https://img.example.com/file/fallback.png');
        });
    });

    describe('GET /blob/* - Stream file', () => {
        it('should stream an R2 object through the blob route', async () => {
            const r2Env = createMockEnv({
                R2_BUCKET: {
                    get: async (key: string) => {
                        if (key !== 'images/test.txt') {
                            return null;
                        }

                        return {
                            key,
                            size: 4,
                            etag: 'etag',
                            httpEtag: 'etag',
                            uploaded: new Date('2025-01-01T00:00:00Z'),
                            storageClass: 'Standard',
                            checksums: {} as R2Checksums,
                            httpMetadata: { contentType: 'text/plain' },
                            writeHttpMetadata(headers: Headers) {
                                headers.set('Content-Type', 'text/plain');
                            },
                            body: new Blob(['test']).stream(),
                            bodyUsed: false,
                            arrayBuffer: async () => new TextEncoder().encode('test').buffer,
                            text: async () => 'test',
                            json: async () => ({ value: 'test' }),
                            blob: async () => new Blob(['test']),
                            bytes: async () => new Uint8Array(new TextEncoder().encode('test')),
                        } as unknown as R2ObjectBody;
                    },
                } as unknown as R2Bucket,
                S3_ACCESS_HOST: '' as any,
                S3_ENDPOINT: '' as any,
                S3_BUCKET: '' as any,
                S3_ACCESS_KEY_ID: '',
                S3_SECRET_ACCESS_KEY: '',
            });

            const r2App = createAppWithEnv(r2Env, 1);
            const res = await r2App.request('/blob/images/test.txt', { method: 'GET' }, r2Env);

            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toBe('text/plain');
            expect(await res.text()).toBe('test');
        });

        it('should stream an imgbed-backed blob through the proxy route', async () => {
            globalThis.fetch = async (input) => {
                const request = new Request(input);
                expect(request.url).toBe('https://img.example.com/file/blob.txt');
                return new Response('blob-data', {
                    status: 200,
                    headers: { 'content-type': 'text/plain' },
                });
            };

            const imgbedEnv = createMockEnv({
                S3_ACCESS_HOST: '' as any,
                S3_ENDPOINT: '' as any,
                S3_BUCKET: '' as any,
                S3_ACCESS_KEY_ID: '',
                S3_SECRET_ACCESS_KEY: '',
            });

            const blobApp = createAppWithConfigs(imgbedEnv, 1, {
                'storage.provider': 'imgbed',
                'storage.map.images/test.txt': 'https://img.example.com/file/blob.txt',
            });

            const res = await blobApp.request('/blob/images/test.txt', { method: 'GET' }, imgbedEnv);

            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toBe('text/plain');
            expect(await res.text()).toBe('blob-data');
        });
    });
});
