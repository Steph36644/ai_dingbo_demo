export type StageHealth = "idle" | "ok" | "degraded" | "error";

/** 只给 Stage。没有时间轴、转写、密钥、品备注。 */
export type StageView = {
  sessionId: string | null;
  stageLabel: string;
  unreadCount: number;
  suggestion: string | null;
  health: StageHealth;
};

/** Stage 字幕快照。与 Control 的 TranscriptView 同构，但只保留展示必需字段。 */
export type StageTranscriptPayload = {
  sessionId: string | null;
  finals: import("./transcript").TranscriptSegment[];
  partial: import("./transcript").TranscriptSegment | null;
  presentation: import("./transcript").PunctuationOverlay | null;
};
