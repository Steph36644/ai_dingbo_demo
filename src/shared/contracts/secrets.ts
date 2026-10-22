/** 已废弃。产品路径不再读取这个环境变量，只保留名字供清理说明引用。 */
export const CLOUD_ASR_ENV = "DINGBO_CLOUD_ASR_KEY";
export const XFYUN_APP_ID_ENV = "DINGBO_XFYUN_APP_ID";
export const XFYUN_API_KEY_ENV = "DINGBO_XFYUN_API_KEY";

/** 渲染进程只能看到这份状态，不能看到密钥本身。 */
export type SecretStatus = {
  configured: boolean;
  source: "os" | "env" | "none";
  backend: "os" | "unavailable";
  editable: boolean;
  devFallback: boolean;
  message: string;
};
