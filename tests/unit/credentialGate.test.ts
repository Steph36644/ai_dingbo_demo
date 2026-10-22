import { describe, expect, it } from "vitest";
import { MemorySecretBackend, SecretStore } from "../../src/main/security/SecretStore";
import {
  XFYUN_CREDENTIALS_CHECKING,
  XFYUN_CREDENTIALS_MISSING,
  rejectionForAsrStart,
  startControlState,
  xfyunStartBlockReason,
} from "../../src/shared/session/credentialGate";

const APP_ID = "xfyun-gate-app-id";
const API_KEY = "xfyun-gate-api-key";

describe("讯飞开始前门禁", () => {
  it("未配置或状态未知时给出准备区原因，配好后放行", () => {
    expect(xfyunStartBlockReason("xfyun", false)).toBe(XFYUN_CREDENTIALS_MISSING);
    expect(xfyunStartBlockReason("xfyun", null)).toBe(XFYUN_CREDENTIALS_CHECKING);
    expect(xfyunStartBlockReason("xfyun", true)).toBeNull();
    expect(XFYUN_CREDENTIALS_MISSING).toBe("未配置讯飞 APPID/APIKey，请到设置页填写");
    expect(XFYUN_CREDENTIALS_MISSING).not.toContain(APP_ID);
    expect(XFYUN_CREDENTIALS_CHECKING).not.toContain(API_KEY);
  });

  it("FunASR 和 Fake 不受讯飞凭据影响，框架不合法仍禁用开始", () => {
    for (const asrId of ["funasr", "fake"] as const) {
      expect(xfyunStartBlockReason(asrId, false)).toBeNull();
      expect(xfyunStartBlockReason(asrId, null)).toBeNull();
      expect(
        startControlState({
          asrId,
          frameworkOk: true,
          busy: false,
          stopping: false,
          xfyunConfigured: false,
          asrHealth: { ok: true },
        }),
      ).toEqual({ disabled: false, reason: null });
    }

    expect(
      startControlState({
        asrId: "xfyun",
        frameworkOk: true,
        busy: false,
        stopping: false,
        xfyunConfigured: false,
      }),
    ).toEqual({ disabled: true, reason: XFYUN_CREDENTIALS_MISSING });

    expect(
      startControlState({
        asrId: "xfyun",
        frameworkOk: true,
        busy: false,
        stopping: false,
        xfyunConfigured: true,
        asrHealth: { ok: true },
      }),
    ).toEqual({ disabled: false, reason: null });

    expect(
      startControlState({
        asrId: "xfyun",
        frameworkOk: false,
        busy: false,
        stopping: false,
        xfyunConfigured: true,
      }).disabled,
    ).toBe(true);
  });

  it("健康未知、检查中或失败都禁用开始，通过后才放行", () => {
    const base = {
      asrId: "funasr" as const,
      frameworkOk: true,
      busy: false,
      stopping: false,
      xfyunConfigured: null,
    };
    expect(startControlState({ ...base, asrHealth: null }).disabled).toBe(true);
    expect(startControlState({ ...base, asrHealth: null }).reason).toContain("尚未通过");
    expect(startControlState({ ...base, asrHealth: null, healthChecking: true }).reason).toContain("正在检查");
    expect(startControlState({ ...base, asrHealth: { ok: false, detail: "模型加载失败" } })).toEqual({
      disabled: true,
      reason: "模型加载失败",
    });
    expect(startControlState({ ...base, asrHealth: { ok: true } })).toEqual({ disabled: false, reason: null });
  });

  it("主进程只在讯飞路径读取是否已配置，缺凭据时不进入开始", async () => {
    const calls: string[] = [];
    expect(await rejectionForAsrStart("funasr", async () => {
      calls.push("funasr");
      return false;
    })).toBeNull();
    expect(await rejectionForAsrStart("fake", async () => {
      calls.push("fake");
      return false;
    })).toBeNull();
    expect(calls).toEqual([]);
    expect(await rejectionForAsrStart("xfyun", async () => false)).toBe(XFYUN_CREDENTIALS_MISSING);
    expect(await rejectionForAsrStart("xfyun", async () => true)).toBeNull();
  });

  it("safeStorage 状态只提供布尔，不成对的环境变量算未配置", async () => {
    const xfyunBackend = new MemorySecretBackend(true);
    const store = new SecretStore({
      backend: new MemorySecretBackend(true),
      xfyunBackend,
      allowEnvFallback: true,
      env: { DINGBO_XFYUN_APP_ID: APP_ID },
    });
    expect((await store.status("xfyun")).configured).toBe(false);
    expect(JSON.stringify(await store.status("xfyun"))).not.toContain(APP_ID);
    expect(await rejectionForAsrStart("xfyun", async () => (await store.status("xfyun")).configured)).toBe(
      XFYUN_CREDENTIALS_MISSING,
    );

    await store.setXfyunCredentials({ appId: APP_ID, apiKey: API_KEY });
    const ready = await store.status("xfyun");
    expect(ready.configured).toBe(true);
    expect(JSON.stringify(ready)).not.toContain(APP_ID);
    expect(JSON.stringify(ready)).not.toContain(API_KEY);
    expect(await rejectionForAsrStart("funasr", async () => (await store.status("xfyun")).configured)).toBeNull();
    expect(await rejectionForAsrStart("xfyun", async () => ready.configured)).toBeNull();
  });
});
