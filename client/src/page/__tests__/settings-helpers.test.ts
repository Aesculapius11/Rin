import { describe, expect, it } from "vitest";
import {
  buildStorageSettingsDraftValue,
  normalizeSettingsState,
  prepareSettingsDraftForSave,
} from "../settings-helpers";

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

  it("tracks when a masked imgbed token exists while exposing an empty editable value", () => {
    const state = normalizeSettingsState({
      clientConfig: {},
      serverConfig: {
        "storage.provider": "imgbed",
        "imgbed.api_token": "••••••••",
      },
    });

    expect(state.hasStoredImgbedApiToken).toBe(true);
    expect(state.draft.serverConfig["imgbed.api_token"]).toBe("");

    const value = buildStorageSettingsDraftValue(state.draft, state.hasStoredImgbedApiToken);

    expect(value.apiToken).toBe("");
    expect(value.apiTokenSet).toBe(true);
  });

  it("preserves an untouched stored imgbed token when saving an unrelated change", () => {
    const draft = {
      clientConfig: {
        "site.name": "Rin",
      },
      serverConfig: {
        "storage.provider": "imgbed",
        "imgbed.endpoint": "https://img.example.com",
        "imgbed.api_token": "",
      },
    };

    expect(
      prepareSettingsDraftForSave(draft, {
        hasStoredAiApiKey: false,
        hasStoredImgbedApiToken: true,
      }),
    ).toEqual({
      clientConfig: {
        "site.name": "Rin",
      },
      serverConfig: {
        "storage.provider": "imgbed",
        "imgbed.endpoint": "https://img.example.com",
        "imgbed.api_token": "••••••••",
      },
    });
  });
});
