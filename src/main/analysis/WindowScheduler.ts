export type AnalysisRequest = {
  endMs: number;
  windowMs: number;
  finalFlush: boolean;
  scheduledAtMs: number;
};

/**
 * 音频时钟到达完整窗口后才常规触发，之后每 intervalMs 一次。
 * 上一轮还没结束就跳过，不并行堆积。
 */
export class WindowScheduler {
  private stopped = true;
  private busy = false;
  private nextDueMs = 0;

  constructor(
    private readonly options: {
      getWindowMs: () => number;
      getIntervalMs: () => number;
      onAnalyze: (request: AnalysisRequest) => void;
      onOverrun: (audioClockMs: number) => void;
    },
  ) {}

  start(): void {
    this.stopped = false;
    this.busy = false;
    this.nextDueMs = this.options.getWindowMs();
  }

  stop(): void {
    this.stopped = true;
  }

  tick(audioClockMs: number): void {
    if (this.stopped) return;
    const windowMs = this.options.getWindowMs();
    const intervalMs = this.options.getIntervalMs();
    if (audioClockMs < windowMs || audioClockMs < this.nextDueMs) return;
    if (this.busy) {
      this.options.onOverrun(audioClockMs);
      this.nextDueMs = audioClockMs + intervalMs;
      return;
    }
    const scheduledAtMs = this.nextDueMs;
    this.busy = true;
    try {
      this.options.onAnalyze({ endMs: audioClockMs, windowMs, finalFlush: false, scheduledAtMs });
    } finally {
      this.busy = false;
      this.nextDueMs = Math.max(this.nextDueMs, audioClockMs + intervalMs);
    }
  }

  finalFlush(audioClockMs: number): void {
    if (audioClockMs <= 0) return;
    if (this.busy) {
      this.options.onOverrun(audioClockMs);
      return;
    }
    const windowMs = this.options.getWindowMs();
    const intervalMs = this.options.getIntervalMs();
    this.busy = true;
    try {
      this.options.onAnalyze({
        endMs: audioClockMs,
        windowMs,
        finalFlush: true,
        scheduledAtMs: audioClockMs,
      });
    } finally {
      this.busy = false;
      this.nextDueMs = Math.max(this.nextDueMs, audioClockMs + intervalMs);
    }
  }
}
