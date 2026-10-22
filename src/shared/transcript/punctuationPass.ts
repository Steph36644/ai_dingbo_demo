/**
 * 周期性把尚未送出的 final 原文送给标点模型。
 * 模型 cache 留在 sidecar；这里只累积展示用的标点文本。
 */

import type { PunctuationDisplayConfig } from "@shared/config/punctuation";
import type { PunctuationMode, PunctuationOverlay, PunctuateResponse } from "@shared/contracts/transcript";
import type { SentencePiece } from "./sentences";
import { joinPieces, mergePunctuationChunk, splitPunctuatedPieces } from "./punctuationDisplay";

export type DisplayPunctuator = {
  punctuate(text: string, mode: PunctuationMode, reset?: boolean): Promise<PunctuateResponse>;
};

export function punctuationFailureIsRetryable(detail: string | undefined): boolean {
  if (!detail) return false;
  return detail.includes("加载中") || detail.includes("未连接") || detail.includes("超时");
}

type PendingBatch = {
  pieces: SentencePiece[];
  text: string;
  reset: boolean;
};

export class PunctuationPass {
  private unsent: SentencePiece[] = [];
  private pending: SentencePiece[] = [];
  private covered: SentencePiece[] = [];
  private accumulated = "";
  private overlayValue: PunctuationOverlay | null = null;
  private lastAttemptAt: number | null = null;
  private inFlight = false;
  private failures = 0;
  private pausedFlag = false;
  private needsReset = false;
  private mode: PunctuationMode = "realtime";
  /** 失败后先等间隔，避免条数门槛把同一段文本立刻再送一遍。 */
  private suppressCountTrigger = false;

  constructor(private readonly config: PunctuationDisplayConfig) {}

  reset(): void {
    this.unsent = [];
    this.pending = [];
    this.covered = [];
    this.accumulated = "";
    this.overlayValue = null;
    this.lastAttemptAt = null;
    this.inFlight = false;
    this.failures = 0;
    this.pausedFlag = false;
    this.needsReset = true;
    this.mode = "realtime";
    this.suppressCountTrigger = false;
  }

  markCacheReset(): void {
    this.needsReset = true;
  }

  overlay(): PunctuationOverlay | null {
    return this.overlayValue ? { ...this.overlayValue, sourceIds: [...this.overlayValue.sourceIds] } : null;
  }

  paused(): boolean {
    return this.pausedFlag;
  }

  noteFinal(piece: SentencePiece, now: number): void {
    if (this.lastAttemptAt == null) this.lastAttemptAt = now;
    this.unsent.push(piece);
  }

  /** 0 表示现在就该送。没有待送文本、正在请求或已暂停时返回 null。 */
  millisecondsUntilDue(now: number): number | null {
    if (this.pausedFlag || this.inFlight || this.unsent.length === 0) return null;
    const elapsed = now - (this.lastAttemptAt ?? now);
    if (this.suppressCountTrigger) {
      if (elapsed >= this.config.intervalMs) {
        this.suppressCountTrigger = false;
        return 0;
      }
      return this.config.intervalMs - elapsed;
    }
    if (this.reachedBatchThreshold()) return 0;
    if (elapsed >= this.config.intervalMs) return 0;
    return this.config.intervalMs - elapsed;
  }

  begin(now: number): PendingBatch | null {
    if (this.millisecondsUntilDue(now) !== 0) return null;
    return this.takeBatch(now);
  }

  /** 停播时不再等间隔，把还没送出的尾巴送一次。 */
  drain(now: number): PendingBatch | null {
    if (this.pausedFlag || this.inFlight || this.unsent.length === 0) return null;
    return this.takeBatch(now);
  }

  complete(response: PunctuateResponse): PunctuationOverlay | null {
    const batch = this.pending;
    this.pending = [];
    this.inFlight = false;
    if (batch.length === 0) return this.overlay();
    if (!response.ok) {
      this.unsent = [...batch, ...this.unsent];
      this.suppressCountTrigger = true;
      if (!punctuationFailureIsRetryable(response.detail)) this.failures += 1;
      if (this.failures >= this.config.maxConsecutiveFailures) this.pausedFlag = true;
      return this.overlay();
    }
    const merged = mergePunctuationChunk(this.accumulated, response.text);
    const covered = [...this.covered, ...batch];
    if (!splitPunctuatedPieces(covered, merged)) {
      this.pausedFlag = true;
      this.unsent = [...batch, ...this.unsent];
      return this.overlay();
    }
    this.failures = 0;
    this.suppressCountTrigger = false;
    this.accumulated = merged;
    this.covered = covered;
    this.needsReset = false;
    this.mode = response.mode;
    this.overlayValue = { sourceIds: covered.map((piece) => piece.id), text: merged, mode: response.mode };
    return this.overlay();
  }

  fail(): void {
    this.cancelBegin();
    this.suppressCountTrigger = true;
    this.failures += 1;
    if (this.failures >= this.config.maxConsecutiveFailures) this.pausedFlag = true;
  }

  /** 还没有标点器时把批次放回，不计失败，避免空转。 */
  cancelBegin(): void {
    const batch = this.pending;
    this.pending = [];
    this.inFlight = false;
    if (batch.length > 0) this.unsent = [...batch, ...this.unsent];
  }

  offlineText(pieces: readonly SentencePiece[]): string | null {
    const text = joinPieces(pieces);
    if (!text.trim()) return null;
    if (Array.from(text).length > this.config.offlineMaxChars) return null;
    return text;
  }

  commitOffline(pieces: readonly SentencePiece[], response: PunctuateResponse): boolean {
    if (!response.ok || response.mode !== "offline") return false;
    if (!splitPunctuatedPieces(pieces, response.text)) return false;
    this.accumulated = response.text;
    this.covered = pieces.map((piece) => ({ ...piece }));
    this.unsent = [];
    this.pending = [];
    this.mode = "offline";
    this.overlayValue = {
      sourceIds: pieces.map((piece) => piece.id),
      text: response.text,
      mode: "offline",
    };
    return true;
  }

  private reachedBatchThreshold(): boolean {
    if (this.unsent.length >= this.config.everyNFinals) return true;
    return Array.from(joinPieces(this.unsent)).length >= this.config.maxCharsPerPass;
  }

  private takeBatch(now: number): PendingBatch | null {
    const pieces: SentencePiece[] = [];
    let text = "";
    for (const piece of this.unsent) {
      const next = joinPieces([...pieces, piece]);
      if (pieces.length > 0 && Array.from(next).length > this.config.maxCharsPerPass) break;
      pieces.push(piece);
      text = next;
    }
    if (pieces.length === 0 || !text.trim()) return null;
    this.unsent = this.unsent.slice(pieces.length);
    this.pending = pieces;
    this.inFlight = true;
    this.lastAttemptAt = now;
    const reset = this.needsReset;
    return { pieces, text, reset };
  }
}

export class DisplayPunctuationScheduler {
  private readonly pass: PunctuationPass;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private stopped = false;
  private finishing = false;
  private inflight: Promise<void> | null = null;
  private loggedPause = false;

  constructor(
    private readonly config: PunctuationDisplayConfig,
    private readonly emit: (overlay: PunctuationOverlay | null, paused: boolean) => void,
    private readonly getPunctuator: () => DisplayPunctuator | null,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.pass = new PunctuationPass(config);
  }

  reset(): void {
    this.generation += 1;
    this.clearTimer();
    this.stopped = false;
    this.finishing = false;
    this.loggedPause = false;
    this.pass.reset();
    this.emit(null, false);
  }

  markCacheReset(): void {
    this.pass.markCacheReset();
  }

  overlay(): PunctuationOverlay | null {
    return this.pass.overlay();
  }

  noteFinal(piece: SentencePiece): void {
    if (this.stopped || this.finishing) return;
    this.pass.noteFinal(piece, this.now());
    this.arm();
  }

  async finish(pieces: readonly SentencePiece[]): Promise<void> {
    this.finishing = true;
    this.clearTimer();
    const current = this.inflight;
    if (current) await current.catch(() => undefined);
    const punctuator = this.getPunctuator();
    if (punctuator) {
      await this.flushRealtime(punctuator);
      const offline = this.pass.offlineText(pieces);
      if (offline) {
        try {
          const response = await withTimeout(
            punctuator.punctuate(offline, "offline", false),
            this.config.offlineTimeoutMs,
          );
          this.pass.commitOffline(pieces, response);
        } catch {
          // 离线美化失败就留下实时标点，或继续用原文。
        }
      }
    }
    this.finishing = false;
    this.stopped = true;
    this.publish();
  }

  private arm(): void {
    if (this.stopped || this.finishing) return;
    this.clearTimer();
    const wait = this.pass.millisecondsUntilDue(this.now());
    if (wait == null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const run = this.run();
      this.inflight = run.finally(() => {
        if (this.inflight === run) this.inflight = null;
      });
    }, wait);
  }

  private async run(): Promise<void> {
    const generation = this.generation;
    const punctuator = this.getPunctuator();
    const batch = this.pass.begin(this.now());
    if (!punctuator) {
      if (batch) this.pass.cancelBegin();
      return;
    }
    if (!batch) return;
    try {
      const response = await withTimeout(
        punctuator.punctuate(batch.text, "realtime", batch.reset),
        this.config.requestTimeoutMs,
      );
      if (generation !== this.generation) return;
      this.pass.complete(response);
    } catch {
      if (generation !== this.generation) return;
      this.pass.fail();
    }
    this.publish();
    if (!this.stopped && !this.finishing) this.arm();
  }

  private async flushRealtime(punctuator: DisplayPunctuator): Promise<void> {
    const batch = this.pass.drain(this.now());
    if (!batch) return;
    try {
      const response = await withTimeout(
        punctuator.punctuate(batch.text, "realtime", batch.reset),
        this.config.requestTimeoutMs,
      );
      this.pass.complete(response);
    } catch {
      this.pass.fail();
    }
  }

  private publish(): void {
    const paused = this.pass.paused();
    if (paused && !this.loggedPause) this.loggedPause = true;
    this.emit(this.pass.overlay(), paused);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("标点超时")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("标点失败"));
      },
    );
  });
}
