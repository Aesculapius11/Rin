import { describe, expect, it } from "vitest";
import { buildStorageSettingsDraftValue } from "../settings-helpers";

describe("buildStorageSettingsDraftValue", () => {
  it("should build imgbed storage settings state from the draft and defaults", () => {
    const value = buildStorageSettingsDraftValue({
      clientConfig: {},
      serverConfig: {
        "storage.provider": "imgbed",
        "imgbed.endpoint": "https://img.example.com",
      },
    });

    expect(value.provider).toBe("imgbed");
    expect(value.endpoint).toBe("https://img.example.com");
    expect(value.apiToken).toBe("");
    expect(value.uploadPath).toBe("/upload");
    expect(value.requestFieldName).toBe("file");
    expect(value.extraQuery).toBe("");
  });
});
