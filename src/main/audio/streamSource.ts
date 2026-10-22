import { streamNoFramesMessage } from "@shared/audio/streamCapture";
import { AUDIO } from "@shared/config/defaults";
import type { PcmChunkPayload } from "@shared/contracts/audio";
import { PcmFramer } from "./framer";
import { AudioPumpError, type AudioPump, type AudioSink } from "./types";

export type StreamCaptureHooks = {
  open: (sessionId: string, url: string) => Promise<void> | void;
  close: () => Promise<void> | void;
  reload: () => void;
  /**
   * 长时间没有音频时的回调。
   * Windows 上显示播放窗，方便扫码登录；macOS 上由 StreamWindowManager 改成通知主界面，不 show()。
   */
  reveal: () => void;
  timeoutMs?: number;
  revealAfterMs?: number;
  /** 一次降级里重复 rearm 的最短间隔。页面重载本身就会造成数秒空洞。 */
  rearmCooldownMs?: number;
};

/**
 * 直播流泵。声音来自隐藏播放窗的 WebAudio 旁路，主进程仍只消费渲染进程送来的 PCM。
 * 首帧之前停在 preparing；超时视为失败，不进入 running。
 */
export class StreamAudioPump implements AudioPump {
  readonly id = "stream" as const;
  readonly monitorsLiveness = true;
  private readonly timeoutMs: number;
  private readonly revealAfterMs: number;
  private readonly rearmCooldownMs: number;
  private readonly url: string;
  private sessionId = "";
  private sink: AudioSink | null = null;
  private framer: PcmFramer | null = null;
  private pending: { reject: (error: Error) => void } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private revealTimer: ReturnType<typeof setTimeout> | null = null;
  private opened = false;
  private generation = 0;
  private rearmLockedUntil = 0;

  constructor(private readonly hooks: StreamCaptureHooks & { url: string }) {
    this.url = hooks.url;
    this.timeoutMs = hooks.timeoutMs ?? AUDIO.streamStartTimeoutMs;
    this.revealAfterMs = hooks.revealAfterMs ?? AUDIO.streamRevealAfterMs;
    this.rearmCooldownMs = hooks.rearmCooldownMs ?? AUDIO.streamRearmCooldownMs;
  }

  prepare(): void {}

  start(sessionId: string, sink: AudioSink): Promise<void> {
    this.cancelPending();
    const generation = ++this.generation;
    this.sessionId = sessionId;
    this.sink = sink;
    this.framer = new PcmFramer(sessionId);
    this.opened = false;

    // 等待器必须在第一次 await 之前装好：ingest / stop 可能紧接着 start 被调用。
    const waiting = new Promise<void>((resolve, reject) => {
      this.pending = { reject };
      this.timer = setTimeout(() => {
        this.fail(
          new AudioPumpError(
            "stream_no_frames",
            streamNoFramesMessage(this.timeoutMs, process.platform),
          ),
        );
      }, this.timeoutMs);
      this.revealTimer = setTimeout(() => {
        if (generation === this.generation && !this.opened) this.hooks.reveal();
      }, this.revealAfterMs);
      this.resolveStart = resolve;
    });
    // 调用方会 await 同一个 promise；这里先挂上 catch，避免失败时变成未处理拒绝。
    void waiting.catch(() => undefined);

    try {
      void Promise.resolve(this.hooks.open(sessionId, this.url)).catch((error: unknown) => {
        if (generation === this.generation) {
          this.fail(
            new AudioPumpError(
              "stream_open_failed",
              error instanceof Error ? error.message : "直播流窗口打开失败。",
            ),
          );
        }
      });
    } catch (error) {
      this.fail(
        new AudioPumpError("stream_open_failed", error instanceof Error ? error.message : "直播流窗口打开失败。"),
      );
    }
    return waiting;
  }

  ingest(chunk: PcmChunkPayload): void {
    if (!this.framer || !this.sink || chunk.sessionId !== this.sessionId) return;
    const frames = this.framer.push(chunk);
    if (frames.length > 0) this.rearmLockedUntil = 0;
    if (frames.length > 0 && !this.opened) {
      this.opened = true;
      this.clearTimers();
      this.pending = null;
      this.resolveStart?.();
      this.resolveStart = null;
    }
    for (const frame of frames) this.sink.onFrame(frame);
  }

  fail(error: Error): void {
    if (!this.opened && this.pending) {
      const { reject } = this.pending;
      this.pending = null;
      this.resolveStart = null;
      this.clearTimers();
      reject(error);
      return;
    }
    this.sink?.onCaptureError({
      code: error instanceof AudioPumpError ? error.code : "capture_failed",
      message: error.message,
    });
  }

  failCapture(message: string): void {
    this.fail(new AudioPumpError("capture_failed", message));
  }

  rearm(): void {
    if (!this.sink || !this.sessionId) return;
    const now = Date.now();
    // 会话层会按 1/2/4/8 秒连打 5 次。每次都 loadURL 会把刚开始播的页面再次拆掉，
    // 音频永远回不来，最后 reconnect_exhausted，而 FunASR 还没机会见到人声。
    if (now < this.rearmLockedUntil) return;
    this.rearmLockedUntil = now + this.rearmCooldownMs;
    this.hooks.reload();
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.cancelPending();
    this.framer = null;
    this.sink = null;
    this.opened = false;
    this.sessionId = "";
    await this.hooks.close();
  }

  private resolveStart: (() => void) | null = null;

  private cancelPending(): void {
    const pending = this.pending;
    this.pending = null;
    this.resolveStart = null;
    this.clearTimers();
    pending?.reject(new AudioPumpError("cancelled", "已取消直播流采集"));
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.revealTimer) clearTimeout(this.revealTimer);
    this.timer = null;
    this.revealTimer = null;
  }
}
