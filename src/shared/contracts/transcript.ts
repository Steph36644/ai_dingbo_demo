export type TranscriptSegment = {
  id: string;
  sessionId: string;
  sourceResultId: string;
  startMs: number;
  endMs: number;
  text: string;
  normalizedText: string;
  isFinal: boolean;
  /** 无词级时间戳、按字符比例裁剪进窗口时为 true。 */
  estimatedTiming?: boolean;
};

export type SpeechInterval = { startMs: number; endMs: number };
export type SilenceInterval = { startMs: number; endMs: number };
export type GapInterval = { startMs: number; endMs: number };

export type WindowSnapshot = {
  id: string;
  sessionId: string;
  windowStartMs: number;
  windowEndMs: number;
  triggeredAtMs: number;
  frameworkRevision: string;
  segments: TranscriptSegment[];
  speechIntervals: SpeechInterval[];
  silenceIntervals: SilenceInterval[];
  gapIntervals: GapInterval[];
  audioCoverageMs: number;
  finalTextCoverageMs: number;
};

export type PunctuationMode = "realtime" | "offline";

/** 展示层覆盖。不写入 JSONL，也不替换规则用的原文。 */
export type PunctuationOverlay = {
  sourceIds: string[];
  text: string;
  mode: PunctuationMode;
};

export type PunctuateResponse = {
  ok: boolean;
  text: string;
  mode: PunctuationMode;
  detail?: string;
};

export type CaptionPresentation = {
  sessionId: string;
  overlay: PunctuationOverlay | null;
  /** 连续失败后本场不再请求实时标点。字幕退回原文。 */
  paused: boolean;
};

export type TranscriptView = {
  sessionId: string | null;
  finals: TranscriptSegment[];
  partial: TranscriptSegment | null;
  /** 当前展示覆盖。缺省表示还没有标点结果。 */
  presentation?: PunctuationOverlay | null;
};

export type TranscriptDelta =
  | { sessionId: string; kind: "reset" }
  | { sessionId: string; kind: "partial" | "final"; segment: TranscriptSegment };
