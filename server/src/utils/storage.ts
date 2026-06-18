import { path_join } from "./path";
import { putImgBedObject } from "./imgbed";
import { buildS3ObjectUrl, createS3Client, putObject as putS3Object } from "./s3";

type StorageTarget =
  | {
      type: "imgbed";
      folder: string;
    }
  | {
      type: "r2";
      bucket: R2Bucket;
      folder: string;
      publicBaseUrl: string;
    }
  | {
      type: "s3";
      env: Env;
      folder: string;
      publicBaseUrl: string;
    };

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

type ConfigReader = {
  get(key: string): Promise<unknown>;
  set?(key: string, value: unknown, save?: boolean): Promise<void>;
  save?(): Promise<void>;
};

const STORAGE_MAP_PREFIX = "storage.map.";

function getStorageMapKey(storageKey: string) {
  return `${STORAGE_MAP_PREFIX}${storageKey}`;
}

async function getImgBedMappedUrl(serverConfig: ConfigReader | undefined, storageKey: string) {
  if (!serverConfig) {
    return null;
  }

  const mappedUrl = await serverConfig.get(getStorageMapKey(storageKey));
  if (typeof mappedUrl !== "string") {
    return null;
  }

  const trimmed = mappedUrl.trim();
  return trimmed ? trimmed : null;
}

async function saveImgBedMappedUrl(serverConfig: ConfigReader | undefined, storageKey: string, url: string) {
  if (!serverConfig?.set) {
    return;
  }

  await serverConfig.set(getStorageMapKey(storageKey), url, false);
  await serverConfig.save?.();
}

export async function resolveStorageTarget(env: Env, serverConfig?: ConfigReader): Promise<StorageTarget> {
  const folder = env.S3_FOLDER || "";
  const publicBaseUrl = trimTrailingSlash(env.S3_ACCESS_HOST || env.S3_ENDPOINT || "");
  const provider = String((await serverConfig?.get("storage.provider")) ?? "").trim();

  if (provider === "imgbed") {
    return {
      type: "imgbed",
      folder,
    };
  }

  if (env.R2_BUCKET) {
    return {
      type: "r2",
      bucket: env.R2_BUCKET,
      folder,
      publicBaseUrl,
    };
  }

  if (!env.S3_ENDPOINT) {
    throw new Error("S3_ENDPOINT is not defined");
  }
  if (!env.S3_ACCESS_KEY_ID) {
    throw new Error("S3_ACCESS_KEY_ID is not defined");
  }
  if (!env.S3_SECRET_ACCESS_KEY) {
    throw new Error("S3_SECRET_ACCESS_KEY is not defined");
  }
  if (!env.S3_BUCKET) {
    throw new Error("S3_BUCKET is not defined");
  }

  return {
    type: "s3",
    env,
    folder,
    publicBaseUrl,
  };
}

function encodeStorageKey(key: string) {
  return key
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildBlobUrl(storageKey: string, baseUrl?: string) {
  const encodedKey = encodeStorageKey(storageKey);
  const path = `/api/blob/${encodedKey}`;

  if (!baseUrl) {
    return path;
  }

  return `${trimTrailingSlash(baseUrl)}${path}`;
}

function createStorageResponse(object: R2ObjectBody | R2Object, body?: BodyInit | null) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);

  if (object.httpEtag) {
    headers.set("ETag", object.httpEtag);
  }

  if (!headers.has("Content-Length")) {
    headers.set("Content-Length", String(object.size));
  }

  if (!headers.has("Last-Modified")) {
    headers.set("Last-Modified", object.uploaded.toUTCString());
  }

  return new Response(body ?? null, {
    status: 200,
    headers,
  });
}

export async function getStorageObject(env: Env, storageKey: string): Promise<Response | null> {
  if (!env.R2_BUCKET && !env.S3_ENDPOINT) {
    return null;
  }

  if (env.R2_BUCKET) {
    const object = await env.R2_BUCKET.get(storageKey);
    if (!object) {
      return null;
    }
    return createStorageResponse(object, object.body);
  }

  const client = createS3Client(env);
  const response = await client.fetch(buildS3ObjectUrl(env, storageKey), {
    method: "GET",
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch storage object: ${response.status} ${response.statusText}`);
  }

  return response;
}

export async function headStorageObject(env: Env, storageKey: string): Promise<Response | null> {
  if (!env.R2_BUCKET && !env.S3_ENDPOINT) {
    return null;
  }

  if (env.R2_BUCKET) {
    const object = await env.R2_BUCKET.head(storageKey);
    if (!object) {
      return null;
    }
    return createStorageResponse(object);
  }

  const client = createS3Client(env);
  const response = await client.fetch(buildS3ObjectUrl(env, storageKey), {
    method: "HEAD",
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to inspect storage object: ${response.status} ${response.statusText}`);
  }

  return response;
}

export function getStoragePublicUrl(env: Env, storageKey: string, baseUrl?: string) {
  if (env.S3_ACCESS_HOST) {
    return `${trimTrailingSlash(env.S3_ACCESS_HOST)}/${storageKey}`;
  }

  return buildBlobUrl(storageKey, baseUrl);
}

export async function putStorageObject(
  env: Env,
  key: string,
  body: Blob | ArrayBuffer | Uint8Array | string,
  contentType?: string,
  baseUrl?: string,
  serverConfig?: ConfigReader,
) {
  const target = await resolveStorageTarget(env, serverConfig);
  const storageKey = path_join(target.folder, key);

  return putStorageObjectAtKey(env, storageKey, body, contentType, baseUrl, serverConfig);
}

export async function putStorageObjectAtKey(
  env: Env,
  storageKey: string,
  body: Blob | ArrayBuffer | Uint8Array | string,
  contentType?: string,
  baseUrl?: string,
  serverConfig?: ConfigReader,
) {
  const target = await resolveStorageTarget(env, serverConfig);

  if (target.type === "imgbed") {
    if (!(body instanceof File)) {
      throw new Error("ImgBed uploads require a File body");
    }

    const result = await putImgBedObject(serverConfig as ConfigReader, storageKey, body);
    await saveImgBedMappedUrl(serverConfig, storageKey, result.url);
    return result;
  }

  if (target.type === "r2") {
    await target.bucket.put(storageKey, body, {
      httpMetadata: contentType ? { contentType } : undefined,
    });
  } else {
    const client = createS3Client(env);
    await putS3Object(client, env, storageKey, body, contentType);
  }

  return {
    key: storageKey,
    url: getStoragePublicUrl(env, storageKey, baseUrl),
  };
}

export async function getStoredObjectResponse(
  env: Env,
  storageKey: string,
  serverConfig?: ConfigReader,
): Promise<Response | null> {
  const provider = String((await serverConfig?.get("storage.provider")) ?? "").trim().toLowerCase();
  if (provider === "imgbed") {
    const mappedUrl = await getImgBedMappedUrl(serverConfig, storageKey);
    if (!mappedUrl) {
      return null;
    }

    const response = await fetch(mappedUrl);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch storage object: ${response.status} ${response.statusText}`);
    }
    return response;
  }

  return getStorageObject(env, storageKey);
}

export async function headStoredObject(
  env: Env,
  storageKey: string,
  serverConfig?: ConfigReader,
): Promise<Response | null> {
  const provider = String((await serverConfig?.get("storage.provider")) ?? "").trim().toLowerCase();
  if (provider === "imgbed") {
    const mappedUrl = await getImgBedMappedUrl(serverConfig, storageKey);
    if (!mappedUrl) {
      return null;
    }

    const response = await fetch(mappedUrl, { method: "HEAD" });
    if (response.status === 404) {
      return null;
    }
    if (response.ok) {
      return response;
    }
    if (response.status === 405) {
      const fallback = await fetch(mappedUrl);
      if (fallback.status === 404) {
        return null;
      }
      return fallback.ok ? fallback : null;
    }
    return null;
  }

  return headStorageObject(env, storageKey);
}
