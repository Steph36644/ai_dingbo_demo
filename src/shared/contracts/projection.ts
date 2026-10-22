import type { StageHealth } from "./stage";
import type { ActionSignal } from "./actions";

export type SessionProjection = {
  sessionId: string | null;
  sessionState: "idle" | "preparing" | "running" | "degraded" | "error" | "completed";
  stageId: string | null;
  stageLabel: string;
  pinnedIssueId: string | null;
  dismissedIssueIds: string[];
  unreadCount: number;
  suggestion: string | null;
  health: StageHealth;
  /** Control 手填。M5 不写入 JSONL。 */
  productNote: string | null;
  /** Main 的动作状态投影，Stage 不接收。 */
  actionSignals: ActionSignal[];
};
