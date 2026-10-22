import type { AsrId } from "./asr";
import type { AudioSourceId } from "./audio";

export type SessionState =
  | "idle"
  | "preparing"
  | "running"
  | "degraded"
  | "stopping"
  | "completed"
  | "error";

export type SessionError = {
  code: string;
  message: string;
};

export type DemoScriptId = "standard" | "issues";

export type SessionStartOptions = {
  audioSource: AudioSourceId;
  asrId: AsrId;
  /** 只在模拟音频 + Fake ASR 时改变注入文稿。缺省为正常口播。 */
  demoScript?: DemoScriptId;
  /** 只在 audioSource === "stream" 时必填：规范化后的抖音直播间 URL。 */
  streamUrl?: string;
};

export type SessionSnapshot = {
  sessionId: string | null;
  state: SessionState;
  audioSource: AudioSourceId | null;
  asrId: AsrId | null;
  error: SessionError | null;
  guidance: string | null;
  phaseDetail: string | null;
  startedAtIso: string | null;
  audioClockMs: number;
  degradedReason: string | null;
  stopWarning: string | null;
  persistence: "memory" | "jsonl";
  persistenceNote: string;
  replayFile: string | null;
  reconnectAttempt: number | null;
  reconnectMaxAttempts: number | null;
  frameworkTitle: string | null;
  frameworkRevision: string | null;
  unreadCount: number;
  qualityWarning: string | null;
};

export const SESSION_STATES: readonly SessionState[] = [
  "idle",
  "preparing",
  "running",
  "degraded",
  "stopping",
  "completed",
  "error",
];
