export type ActionSignalKind = "stream.push_suggested" | "coupon.issue_suggested";
export type ActionStatus = "pending" | "acknowledged" | "dismissed" | "expired";

/** 推流、发券各自的默认硬冷却。未结束前，换一种说法也不能提前再响。 */
export const DEFAULT_ACTION_COOLDOWN_SECONDS = 180;
/** 示例框架的推荐阶段：讲品或促单，不锁死其中一个。 */
export const RECOMMENDED_ACTION_STAGE_IDS = ["pitch", "close"] as const;

export type ActionRule = {
  id: string;
  kind: ActionSignalKind;
  enabled: boolean;
  /** 旧配置里的单阶段。stageIds 非空时以 stageIds 为准。 */
  stageId: string | null;
  /** 允许多个阶段。空数组再看 stageId；两者都空表示不限阶段。 */
  stageIds?: string[];
  requiredItemIds: string[];
  cooldownSeconds: number;
};
export type ActionConfig = {
  schemaVersion: 1;
  enabled: boolean;
  frameworkRevision: string;
  rules: ActionRule[];
};
export type ActionConfigState = {
  config: ActionConfig;
  warning: string | null;
};
export type ActionSignal = {
  id: string;
  sessionId: string;
  ruleId: string;
  kind: ActionSignalKind;
  emittedAtMs: number;
  frameworkRevision: string;
  stageId: string | null;
  stageLabel: string;
  delivery: "control_only";
  status: ActionStatus;
  handledAtMs: number | null;
  reason: string | null;
  evidence: {
    windowStartMs: number;
    windowEndMs: number;
    items: { id: string; text: string; segmentIds: string[] }[];
    excerpts: { segmentId: string; text: string; startMs: number; endMs: number }[];
    noAvoidHit: boolean;
  };
};
export type ActionsSnapshot = {
  sessionId: string | null;
  enabled: boolean;
  signals: ActionSignal[];
  warning: string | null;
};
export type ActionResolveRequest = {
  sessionId: string;
  signalId: string;
  status: "acknowledged" | "dismissed";
};
export type ActionResult = { ok: boolean; message?: string };
export type ActionHistory = { signals: ActionSignal[]; warning: string | null };

export function defaultActionConfig(frameworkRevision: string, stages?: readonly { id: string }[]): ActionConfig {
  const known = new Set((stages ?? []).map((stage) => stage.id));
  const stageIds = stages && stages.length > 0
    ? RECOMMENDED_ACTION_STAGE_IDS.filter((id) => known.has(id))
    : [];
  const rule = (id: string, kind: ActionSignalKind): ActionRule => ({
    id,
    kind,
    enabled: false,
    stageId: stageIds.length === 1 ? stageIds[0] : null,
    stageIds: [...stageIds],
    requiredItemIds: [],
    cooldownSeconds: DEFAULT_ACTION_COOLDOWN_SECONDS,
  });
  return {
    schemaVersion: 1,
    enabled: false,
    frameworkRevision,
    rules: [rule("stream", "stream.push_suggested"), rule("coupon", "coupon.issue_suggested")],
  };
}
