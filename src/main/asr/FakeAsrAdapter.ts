import { ASR_LANGUAGE, AUDIO } from "@shared/config/defaults";
import type {
  AsrAdapter,
  AsrCapabilities,
  AsrHealth,
  AsrResult,
  AsrStartConfig,
  AsrTransportError,
} from "@shared/contracts/asr";
import type { AudioFrame } from "@shared/contracts/audio";
import { DEMO_UTTERANCES, scriptCycleMs, type DemoUtterance } from "@shared/fixtures/demoUtterances";

export type FakeAsrOptions = {
  utterances?: readonly DemoUtterance[];
  /** 演示时循环脚本，让字幕持续滚动。测试默认关闭。 */
  loop?: boolean;
};

/**
 * 确定性 ASR。同一帧时钟永远得到同一批 partial/final，方便单测和 UI 演示。
 * 它不读取音频内容，只按帧的 startMs 推进脚本。
 */
export class FakeAsrAdapter implements AsrAdapter {
  readonly id = "fake";
  private readonly utterances: readonly DemoUtterance[];
  private readonly loop: boolean;
  private started = false;
  private sessionId = "";
  private clockMs = 0;
  private finalized = new Set<string>();
  private partialText = new Map<string, string>();
  private cycleCursor = 0;
  private resultListeners = new Set<(result: AsrResult) => void>();
  private errorListeners = new Set<(error: AsrTransportError) => void>();

  constructor(options: FakeAsrOptions = {}) {
    this.utterances = options.utterances ?? DEMO_UTTERANCES;
    this.loop = options.loop ?? false;
  }

  capabilities(): AsrCapabilities {
    return {
      streaming: true,
      partialResults: true,
      wordTimestamps: false,
      inputSampleRates: [AUDIO.sampleRate],
    };
  }

  async checkHealth(): Promise<AsrHealth> {
    return { ok: true, detail: "Fake ASR 就绪。结果来自固定脚本，不访问网络，也不加载模型。" };
  }

  async start(config: AsrStartConfig): Promise<void> {
    if (config.language !== ASR_LANGUAGE || config.sampleRate !== AUDIO.sampleRate) {
      throw new Error("Fake ASR 只接受 zh-CN / 16000 Hz");
    }
    this.started = true;
    this.sessionId = config.sessionId;
    this.clockMs = 0;
    this.finalized.clear();
    this.partialText.clear();
    this.cycleCursor = 0;
  }

  async push(frame: AudioFrame): Promise<void> {
    this.assertStarted();
    if (frame.sessionId !== this.sessionId) return;
    const time = frame.startMs + frame.durationMs;
    if (time < this.clockMs) return;
    this.clockMs = time;
    this.emitUntil(this.clockMs, false);
  }

  async flush(): Promise<void> {
    if (!this.started) return;
    this.emitUntil(this.clockMs, true);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.resultListeners.clear();
    this.errorListeners.clear();
  }

  onResult(listener: (result: AsrResult) => void): () => void {
    this.resultListeners.add(listener);
    return () => this.resultListeners.delete(listener);
  }

  onError(listener: (error: AsrTransportError) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private emitUntil(clockMs: number, flushOpen: boolean): void {
    const cycleMs = Math.max(1, scriptCycleMs(this.utterances));
    if (this.utterances.length === 0) return;
    const lastCycle = this.loop ? Math.floor(Math.max(0, clockMs - 1) / cycleMs) : 0;
    const firstCycle = this.loop ? this.cycleCursor : 0;
    for (let cycle = firstCycle; cycle <= lastCycle; cycle += 1) {
      const cycleOrigin = cycle * cycleMs;
      const localEnd = clockMs - cycleOrigin;
      for (let index = 0; index < this.utterances.length; index += 1) {
        const utterance = this.utterances[index];
        if (!utterance) continue;
        const id = `fake-${cycle}-${index}`;
        if (this.finalized.has(id)) continue;
        if (localEnd < utterance.startMs) continue;
        const reachedEnd = localEnd >= utterance.endMs;
        if (!reachedEnd && !flushOpen) {
          this.emitPartial(id, utterance, localEnd);
          continue;
        }
        if (!reachedEnd && flushOpen) {
          const revealed = this.partialText.get(id) ?? reveal(utterance.text, utterance.startMs, utterance.endMs, localEnd);
          this.emitFinal(id, utterance, revealed, Math.max(utterance.startMs, Math.min(utterance.endMs, localEnd)) + cycleOrigin);
          continue;
        }
        this.emitFinal(id, utterance, utterance.text, utterance.endMs + cycleOrigin);
      }
    }
    if (!this.loop) return;
    while (this.cycleCursor < lastCycle && this.cycleDone(this.cycleCursor)) this.cycleCursor += 1;
  }

  private cycleDone(cycle: number): boolean {
    for (let index = 0; index < this.utterances.length; index += 1) {
      if (!this.finalized.has(`fake-${cycle}-${index}`)) return false;
    }
    return true;
  }

  private emitPartial(id: string, utterance: DemoUtterance, localTime: number): void {
    const text = reveal(utterance.text, utterance.startMs, utterance.endMs, localTime);
    if (!text || this.partialText.get(id) === text) return;
    this.partialText.set(id, text);
    const cycle = cycleOf(id);
    const cycleMs = scriptCycleMs(this.utterances);
    this.publish({
      sessionId: this.sessionId,
      providerResultId: id,
      startMs: utterance.startMs + cycle * cycleMs,
      endMs: localTime + cycle * cycleMs,
      text,
      isFinal: false,
      confidence: 1,
    });
  }

  private emitFinal(id: string, utterance: DemoUtterance, text: string, endMs: number): void {
    if (this.finalized.has(id)) return;
    this.finalized.add(id);
    this.partialText.delete(id);
    const cycle = cycleOf(id);
    const cycleMs = scriptCycleMs(this.utterances);
    this.publish({
      sessionId: this.sessionId,
      providerResultId: id,
      startMs: utterance.startMs + cycle * cycleMs,
      endMs,
      text,
      isFinal: true,
      confidence: 1,
    });
  }

  private publish(result: AsrResult): void {
    for (const listener of this.resultListeners) listener(result);
  }

  private assertStarted(): void {
    if (!this.started) throw new Error("Fake ASR 尚未 start");
  }
}

function cycleOf(id: string): number {
  const match = /^fake-(\d+)-/.exec(id);
  return match ? Number(match[1]) : 0;
}

function reveal(text: string, startMs: number, endMs: number, localTime: number): string {
  const chars = Array.from(text);
  if (chars.length === 0) return "";
  const span = Math.max(1, endMs - startMs);
  const progress = Math.max(0, Math.min(1, (localTime - startMs) / span));
  const count = Math.max(1, Math.min(chars.length, Math.floor(chars.length * progress) || 1));
  return chars.slice(0, count).join("");
}
