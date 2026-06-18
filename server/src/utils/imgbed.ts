export class ImgBedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImgBedConfigError";
  }
}

export class ImgBedUpstreamError extends Error {
  status?: number;
  responseText?: string;

  constructor(message = "ImgBed upload failed", options?: { status?: number; responseText?: string }) {
    super(message);
    this.name = "ImgBedUpstreamError";
    this.status = options?.status;
    this.responseText = options?.responseText;
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

function summarizeResponseText(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length > 200 ? `${normalized.slice(0, 200)}...` : normalized;
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
    throw new ImgBedUpstreamError("ImgBed upload failed: transport error");
  }

  if (!response.ok) {
    const responseText = summarizeResponseText(await response.text().catch(() => ""));
    const statusLabel = [response.status, response.statusText].filter(Boolean).join(" ");
    const detail = responseText ? ` - ${responseText}` : "";
    throw new ImgBedUpstreamError(
      `ImgBed upload failed: upstream returned ${statusLabel}${detail}`,
      { status: response.status, responseText },
    );
  }

  let payload: Array<{ publicUrl?: string; src?: string }> | { publicUrl?: string; src?: string };

  try {
    payload = await response.json() as Array<{ publicUrl?: string; src?: string }> | { publicUrl?: string; src?: string };
  } catch {
    throw new ImgBedUpstreamError("ImgBed upload failed: invalid upstream json");
  }

  const first = Array.isArray(payload) ? payload[0] : payload;
  const finalUrl = first?.publicUrl || first?.src;

  if (!finalUrl) {
    throw new ImgBedUpstreamError("ImgBed upload failed: upstream response missing publicUrl/src");
  }

  return {
    key: storageKey,
    url: finalUrl,
  };
}
