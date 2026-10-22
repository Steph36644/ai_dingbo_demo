import type { SecretStatus } from "@shared/contracts/secrets";
import { XFYUN_APP_ID_ENV, XFYUN_API_KEY_ENV } from "@shared/contracts/secrets";
import { noteSensitive } from "./redact";

export type XfyunCredentials = {
  appId: string;
  apiKey: string;
};

export type SecretBackend = {
  available(): boolean;
  get(): Promise<string | null>;
  set(secret: string): Promise<void>;
  clear(): Promise<void>;
};

/** 测试用内存后端。生产路径走 safeStorage，不把明文写进 JSON。 */
export class MemorySecretBackend implements SecretBackend {
  private value: string | null = null;

  constructor(private readonly enabled = true) {}

  available(): boolean {
    return this.enabled;
  }

  async get(): Promise<string | null> {
    return this.enabled ? this.value : null;
  }

  async set(secret: string): Promise<void> {
    if (!this.enabled) throw new Error("secure_storage_unavailable");
    this.value = secret;
  }

  async clear(): Promise<void> {
    this.value = null;
  }
}

const REFUSED = "当前没有可用的系统安全存储，已拒绝保存。不会把密钥写进明文文件。";

export class SecretStore {
  constructor(
    private readonly options: {
      backend: SecretBackend;
      xfyunBackend?: SecretBackend;
      allowEnvFallback: boolean;
      env?: NodeJS.ProcessEnv;
    },
  ) {}

  /**
   * 通用云 ASR 密钥已废弃，没有任何适配器读取。
   * 这里固定返回 null，避免把旧密文或 `DINGBO_CLOUD_ASR_KEY` 解密进内存。
   */
  async readCloudAsrKey(): Promise<string | null> {
    return null;
  }

  async status(provider: "cloud" | "xfyun" = "cloud"): Promise<SecretStatus> {
    if (provider === "xfyun") return this.xfyunStatus();
    return this.deprecatedCloudStatus();
  }

  async readXfyunCredentials(): Promise<XfyunCredentials | null> {
    const backend = this.options.xfyunBackend;
    if (backend?.available()) {
      const stored = await backend.get();
      const parsed = parseXfyunCredentials(stored);
      if (parsed) {
        noteSensitive(parsed.appId);
        noteSensitive(parsed.apiKey);
        return parsed;
      }
    }
    return this.envXfyunCredentials();
  }

  async setXfyunCredentials(credentials: XfyunCredentials): Promise<SecretStatus> {
    noteSensitive(credentials.appId);
    noteSensitive(credentials.apiKey);
    const backend = this.options.xfyunBackend;
    if (!backend?.available()) {
      const status = await this.xfyunStatus();
      return { ...status, message: REFUSED };
    }
    await backend.set(JSON.stringify(credentials));
    const status = await this.xfyunStatus();
    return { ...status, message: "讯飞 APPID 和 APIKey 已写入系统安全存储。界面、日志和复盘都不会带上明文。" };
  }

  async clearXfyunCredentials(): Promise<SecretStatus> {
    const backend = this.options.xfyunBackend;
    if (backend?.available()) await backend.clear();
    const status = await this.xfyunStatus();
    const extra = status.source === "env" ? "系统安全存储已清空，开发环境变量仍会生效。" : "已清除本机保存的讯飞凭据。";
    return { ...status, message: extra };
  }

  async setCloudAsrKey(secret: string): Promise<SecretStatus> {
    noteSensitive(secret);
    return {
      ...this.deprecatedCloudStatus(),
      message: "通用云 ASR 密钥已废弃，未写入。请配置讯飞 APPID 和 APIKey。",
    };
  }

  /** 只删除旧密文文件，不解密、不回传内容。 */
  async clearCloudAsrKey(): Promise<SecretStatus> {
    if (this.options.backend.available()) await this.options.backend.clear();
    return {
      ...this.deprecatedCloudStatus(),
      message: "已清除本机废弃的通用云 ASR 密钥（如有）。有效云凭据只有讯飞 APPID 和 APIKey。",
    };
  }

  private deprecatedCloudStatus(): SecretStatus {
    return {
      configured: false,
      source: "none",
      backend: this.options.backend.available() ? "os" : "unavailable",
      editable: false,
      devFallback: false,
      message: "通用云 ASR 密钥已废弃，没有适配器使用。请配置讯飞 APPID 和 APIKey。界面不会读取或显示旧密钥。",
    };
  }

  private async xfyunStatus(): Promise<SecretStatus> {
    const backend = this.options.xfyunBackend;
    const stored = backend?.available() ? parseXfyunCredentials(await backend.get()) : null;
    if (stored) {
      noteSensitive(stored.appId);
      noteSensitive(stored.apiKey);
    }
    const env = this.envXfyunCredentials();
    const source = stored ? "os" : env ? "env" : "none";
    const editable = backend?.available() ?? false;
    let message = "还没有配置讯飞 APPID 和 APIKey。";
    if (source === "os") message = "讯飞凭据在系统安全存储里。界面看不到明文。";
    else if (source === "env") message = `未打包的开发进程读到了 ${XFYUN_APP_ID_ENV} 和 ${XFYUN_API_KEY_ENV}。界面看不到明文。`;
    else if (!editable) {
      message = this.options.allowEnvFallback
        ? `当前环境没有系统安全存储，不会把凭据写进文件。开发时可以临时设置 ${XFYUN_APP_ID_ENV} 和 ${XFYUN_API_KEY_ENV}。`
        : "当前环境没有系统安全存储，已拒绝保存讯飞凭据。";
    }
    return {
      configured: source !== "none",
      source,
      backend: editable ? "os" : "unavailable",
      editable,
      devFallback: this.options.allowEnvFallback,
      message,
    };
  }

  private envXfyunCredentials(): XfyunCredentials | null {
    if (!this.options.allowEnvFallback) return null;
    const appId = this.options.env?.[XFYUN_APP_ID_ENV]?.trim() ?? "";
    const apiKey = this.options.env?.[XFYUN_API_KEY_ENV]?.trim() ?? "";
    if (!appId || !apiKey) return null;
    noteSensitive(appId);
    noteSensitive(apiKey);
    return { appId, apiKey };
  }
}

function parseXfyunCredentials(raw: string | null): XfyunCredentials | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<XfyunCredentials>;
    const appId = typeof value.appId === "string" ? value.appId.trim() : "";
    const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
    return appId && apiKey ? { appId, apiKey } : null;
  } catch {
    return null;
  }
}
