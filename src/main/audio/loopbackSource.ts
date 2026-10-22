import { AUDIO } from "@shared/config/defaults";
import type { DeviceListResult, PcmChunkPayload } from "@shared/contracts/audio";
import { PcmFramer } from "./framer";
import { AudioPumpError, type AudioPump, type AudioSink } from "./types";

export type LoopbackHooks = {
  assess: () => DeviceListResult | Promise<DeviceListResult>;
  requestCapture: (sessionId: string) => void;
  timeoutMs?: number;
};

/**
 * 主进程侧的环回泵。它不制造音频：只有渲染进程送来的 PCM 才会成帧。
 * 第一帧到达前一直停在调用方的 preparing，超时或采集失败则抛错。
 */
export class LoopbackAudioPump implements AudioPump {
  readonly id = "loopback" as const;
  readonly monitorsLiveness = true;
  private readonly timeoutMs: number;
  private sessionId = "";
  private sink: AudioSink | null = null;
  private framer: PcmFramer | null = null;
  private ready: (() => void) | null = null;
  private failed: ((error: Error) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private opened = false;
  private generation = 0;

  constructor(private readonly hooks: LoopbackHooks) {
    this.timeoutMs = hooks.timeoutMs ?? AUDIO.captureStartTimeoutMs;
  }

  prepare(): void {}

  async start(sessionId: string, sink: AudioSink): Promise<void> {
    const assessment = await this.hooks.assess();
    if (!assessment.loopbackAttemptAllowed) {
      throw new AudioPumpError("loopback_unavailable", assessment.guidance);
    }
    await this.stop();
    const generation = ++this.generation;
    this.sessionId = sessionId;
    this.sink = sink;
    this.framer = new PcmFramer(sessionId);
    this.opened = false;
    this.hooks.requestCapture(sessionId);
    return new Promise<void>((resolve, reject) => {
      this.ready = () => {
        if (generation !== this.generation) return;
        this.opened = true;
        this.clearWaiters();
        resolve();
      };
      this.failed = (error) => {
        if (generation !== this.generation) return;
        this.clearWaiters();
        reject(error);
      };
      this.timer = setTimeout(() => {
        this.fail(
          new AudioPumpError(
            "capture_no_frames",
            `等待 ${this.timeoutMs / 1000} 秒仍没有音频帧。${assessment.guidance}`,
          ),
        );
      }, this.timeoutMs);
    });
  }

  ingest(chunk: PcmChunkPayload): void {
    if (!this.framer || !this.sink || chunk.sessionId !== this.sessionId) return;
    const frames = this.framer.push(chunk);
    if (frames.length > 0) this.ready?.();
    for (const frame of frames) this.sink.onFrame(frame);
  }

  fail(error: Error): void {
    if (!this.opened && this.failed) {
      const reject = this.failed;
      this.clearWaiters();
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
    this.hooks.requestCapture(this.sessionId);
  }

  async stop(): Promise<void> {
    const reject = this.failed;
    this.generation += 1;
    this.clearWaiters();
    this.framer = null;
    this.sink = null;
    this.opened = false;
    this.sessionId = "";
    reject?.(new AudioPumpError("cancelled", "已取消环回采集"));
  }

  private clearWaiters(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ready = null;
    this.failed = null;
  }
}
