/**
 * 展示层周期性标点。只影响字幕怎么分行，不进入规则、JSONL 或 AsrResult。
 *
 * 默认每 4 秒，或每攒够 6 条尚未送出的 final，把原文送给 FunASR 实时标点。
 * 密讲时约 600ms 一条 final，6 条大约 3.6 秒，和 4 秒间隔接近，避免每个块都打模型。
 * 环境变量只在主进程读取：`DINGBO_PUNC_INTERVAL_MS`、`DINGBO_PUNC_EVERY_N_FINALS`。
 */

export const PUNCTUATION_DISPLAY = {
  intervalMs: 4_000,
  everyNFinals: 6,
  maxCharsPerPass: 240,
  offlineMaxChars: 12_000,
  requestTimeoutMs: 2_500,
  offlineTimeoutMs: 3_000,
  maxConsecutiveFailures: 3,
} as const;

export type PunctuationDisplayConfig = {
  intervalMs: number;
  everyNFinals: number;
  maxCharsPerPass: number;
  offlineMaxChars: number;
  requestTimeoutMs: number;
  offlineTimeoutMs: number;
  maxConsecutiveFailures: number;
};

export function punctuationDisplayConfig(
  env: Record<string, string | undefined> = {},
  overrides?: Partial<PunctuationDisplayConfig>,
): PunctuationDisplayConfig {
  return {
    intervalMs: clampInt(overrides?.intervalMs ?? readEnv(env.DINGBO_PUNC_INTERVAL_MS), 1_000, 30_000, PUNCTUATION_DISPLAY.intervalMs),
    everyNFinals: clampInt(
      overrides?.everyNFinals ?? readEnv(env.DINGBO_PUNC_EVERY_N_FINALS),
      1,
      40,
      PUNCTUATION_DISPLAY.everyNFinals,
    ),
    maxCharsPerPass: clampInt(overrides?.maxCharsPerPass, 40, 2_000, PUNCTUATION_DISPLAY.maxCharsPerPass),
    offlineMaxChars: clampInt(overrides?.offlineMaxChars, 200, 100_000, PUNCTUATION_DISPLAY.offlineMaxChars),
    requestTimeoutMs: clampInt(overrides?.requestTimeoutMs, 200, 30_000, PUNCTUATION_DISPLAY.requestTimeoutMs),
    offlineTimeoutMs: clampInt(overrides?.offlineTimeoutMs, 200, 30_000, PUNCTUATION_DISPLAY.offlineTimeoutMs),
    maxConsecutiveFailures: clampInt(
      overrides?.maxConsecutiveFailures,
      1,
      20,
      PUNCTUATION_DISPLAY.maxConsecutiveFailures,
    ),
  };
}

function readEnv(value: string | undefined): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
