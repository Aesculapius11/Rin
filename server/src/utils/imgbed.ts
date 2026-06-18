export class ImgBedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImgBedConfigError";
  }
}

export class ImgBedUpstreamError extends Error {
  constructor(message = "ImgBed upload failed") {
    super(message);
    this.name = "ImgBedUpstreamError";
  }
}

type ConfigReader = {
  get(key: string): Promise<unknown>;
};

function asTrimmedString(value: unknown) {
  return String(value ?? "").trim();
}

function getUploadFileName(storageKey: string) {
  const segments = storageKey.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] || storageKey;
}

export async function putImgBedObject(
  serverConfig: ConfigReader,
  storageKey: string,
  file: File,
): Promise<{ key: string; url: string }> {
  const endpoint = asTrimmedString(await serverConfig.get("imgbed.endpoint"));
  const token = asTrimmedString(await serverConfig.get("imgbed.api_token"));
  const uploadPath = asTrimmedString(await serverConfig.get("imgbed.upload_path")) || "/upload";
  const fieldName = asTrimmedString(await serverConfig.get("imgbed.request_field_name")) || "file";
  const extraQuery = asTrimmedString(await serverConfig.get("imgbed.extra_query"));

  if (!endpoint) {
    throw new ImgBedConfigError("imgbed.endpoint is not defined");
  }
  if (!token) {
    throw new ImgBedConfigError("imgbed.api_token is not defined");
  }

  const url = new URL(uploadPath, endpoint);
  url.searchParams.set("returnFormat", "full");

  if (extraQuery) {
    new URLSearchParams(extraQuery).forEach((value, key) => {
      url.searchParams.append(key, value);
    });
  }

  const formData = new FormData();
  formData.append(fieldName, new File([file], getUploadFileName(storageKey), { type: file.type }));

  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    });
  } catch {
    throw new ImgBedUpstreamError();
  }

  if (!response.ok) {
    throw new ImgBedUpstreamError();
  }

  let payload: Array<{ publicUrl?: string; src?: string }> | { publicUrl?: string; src?: string };

  try {
    payload = await response.json() as Array<{ publicUrl?: string; src?: string }> | { publicUrl?: string; src?: string };
  } catch {
    throw new ImgBedUpstreamError();
  }

  const first = Array.isArray(payload) ? payload[0] : payload;
  const finalUrl = first?.publicUrl || first?.src;

  if (!finalUrl) {
    throw new ImgBedUpstreamError();
  }

  return {
    key: storageKey,
    url: finalUrl,
  };
}
