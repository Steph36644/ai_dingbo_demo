import type { AsrHealth, AsrId } from "@shared/contracts/asr";

/** 准备区与主进程拒绝开始时共用这一句，避免两处文案漂移。 */
export const XFYUN_CREDENTIALS_MISSING = "未配置讯飞 APPID/APIKey，请到设置页填写";

export const XFYUN_CREDENTIALS_CHECKING = "正在确认讯飞凭据，请稍候。";

/**
 * 只根据「是否已配置」决定讯飞能不能开始。
 * `null` 表示渲染进程还没拿到状态，先拦住，避免状态返回前误开。
 * FunASR / Fake 不看讯飞凭据。
 */
export function xfyunStartBlockReason(asrId: AsrId, configured: boolean | null): string | null {
  if (asrId !== "xfyun") return null;
  if (configured === true) return null;
  if (configured === null) return XFYUN_CREDENTIALS_CHECKING;
  return XFYUN_CREDENTIALS_MISSING;
}

export function startControlState(input: {
  asrId: AsrId;
  frameworkOk: boolean;
  busy: boolean;
  stopping: boolean;
  xfyunConfigured: boolean | null;
  asrHealth?: AsrHealth | null;
  healthChecking?: boolean;
}): { disabled: boolean; reason: string | null } {
  const credentialReason = xfyunStartBlockReason(input.asrId, input.xfyunConfigured);
  const healthReason = input.healthChecking
    ? "正在检查识别服务，完成后才能开始。"
    : input.asrHealth?.ok !== true
      ? input.asrHealth?.detail || "识别服务尚未通过健康预检。"
      : null;
  const reason = credentialReason ?? healthReason;
  return {
    reason,
    disabled: input.busy || input.stopping || !input.frameworkOk || reason !== null,
  };
}

/** 主进程在进入 preparing 之前调用。非讯飞不读取讯飞凭据状态。 */
export async function rejectionForAsrStart(
  asrId: AsrId,
  readXfyunConfigured: () => Promise<boolean>,
): Promise<string | null> {
  if (asrId !== "xfyun") return null;
  const configured = await readXfyunConfigured();
  return xfyunStartBlockReason("xfyun", configured);
}
