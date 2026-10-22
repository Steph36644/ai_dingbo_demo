/**
 * 产品默认值集中在这里。阈值按 SDD §7.1 / §7.4 / §9.3，避免散落魔法数字。
 */

/**
 * 直播流外放。默认关：盯播听不见直播声，电脑总音量不动。
 * 只闷直播窗的系统输出，画面显示与环回/模拟音源都不跟这个开关走。
 */
export const STREAM_PLAYBACK = {
  audible: false,
} as const;

export const AUDIO = {
  sampleRate: 16_000,
  channels: 1,
  frameDurationMs: 20,
  frameSamples: 320,
  frameBytes: 640,
  encoding: "pcm_s16le" as const,
  backpressureMs: 5_000,
  /** 连续无帧进入 degraded 的阈值（SDD §7.1）。 */
  gapDegradeMs: 3_000,
  /** 环回打开后等待第一帧的上限。超时视为失败，不进入 running。 */
  captureStartTimeoutMs: 8_000,
  /** 直播流窗口打开后等待第一帧的上限。要覆盖页面加载与扫码登录。 */
  streamStartTimeoutMs: 30_000,
  /**
   * 直播流迟迟没有音频时的等待。
   * Windows 到点后 reveal() 显示画面；macOS 不 show()，只通知主界面。
   */
  streamRevealAfterMs: 6_000,
  /**
   * 直播流重连会整页重载。一次降级里 5 次退避大约 23 秒，
   * 冷却必须盖住这段，否则页面还没再次出声就被下一次重载打断。
   */
  streamRearmCooldownMs: 30_000,
  /** 帧时钟跳变超过该值记为采音缺口，不补零。 */
  gapToleranceMs: 150,
  speechRmsThreshold: 0.02,
  /** 待发送 PCM 字节上限：16 kHz * 16-bit * 5 秒。 */
  backpressureBytes: 16_000 * 2 * 5,
} as const;

export const ANALYSIS_DEFAULTS = {
  windowMs: 300_000,
  intervalMs: 60_000,
  windowMsRange: [60_000, 900_000] as const,
  intervalMsRange: [15_000, 300_000] as const,
} as const;

/** SDD §7.1：指数退避 1/2/4/8 秒，最多 5 次。第 5 次沿用 8 秒。 */
export const RECONNECT = {
  backoffMs: [1_000, 2_000, 4_000, 8_000] as const,
  maxAttempts: 5,
} as const;

export const RHYTHM_DEFAULTS = {
  longSilenceMs: 4_000,
  highSilenceRatio: 0.45,
  highSpeechRatio: 0.92,
  minDenseSpeechMs: 60_000,
  maxSentenceGapMs: 1_200,
  minSentenceLengthChars: 4,
} as const;

/** SDD §8.1 数据质量门槛，以及证据条数。不足时不进用户问题列表。 */
export const QUALITY_GATES = {
  minAudioCoverageRatio: 0.8,
  minSpeechMs: 15_000,
  minFinalTextCoverageRatio: 0.6,
  /** 相对上下限的偏差不超过该比例时，语速问题记为 info。 */
  paceDeviationInfo: 0.1,
  qualityWarningWindows: 3,
  analysisTimeoutMs: 10_000,
  maxExcerpts: 3,
  maxSuggestions: 3,
  maxCoverageSegments: 20,
} as const;

/**
 * 冷却从上次命中的会话时钟起算。
 * avoid 为 3 分钟，语速/节奏为 5 分钟（SDD §9）。
 * must_say 原文没写分钟数，和 avoid 同用 3 分钟，避免内容问题用两套口径。
 */
export const ISSUE_COOLDOWN_MS = {
  avoid: 180_000,
  mustSay: 180_000,
  pace: 300_000,
  rhythm: 300_000,
} as const;

export const ASR_LANGUAGE = "zh-CN" as const;

/** 纯语气词。整段只剩这些字符时不计入有效字数。 */
export const FILLER_CHARS = "啊嗯呃哦呀呢吧嘛哇额哎诶啦嘞咯哈";
