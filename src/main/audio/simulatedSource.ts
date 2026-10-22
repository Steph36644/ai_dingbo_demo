import { AUDIO } from "@shared/config/defaults";
import type { AudioFrame } from "@shared/contracts/audio";
import {
  DEMO_UTTERANCES,
  scriptCycleMs,
  utteranceActive,
  type DemoUtterance,
} from "@shared/fixtures/demoUtterances";
import { computeRms, speechProbabilityFromRms } from "./pcm";
import type { AudioPump, AudioSink } from "./types";

export type SimulatedAudioOptions = {
  utterances?: readonly DemoUtterance[];
  loop?: boolean;
  intervalMs?: number;
};

/**
 * 开发用音频注入。帧是真实的 PCM，但来源不是声卡。
 * UI 必须把它标成模拟，不能标成环回成功。
 */
export class SimulatedAudioPump implements AudioPump {
  readonly id = "simulated" as const;
  readonly monitorsLiveness = false;
  private readonly utterances: readonly DemoUtterance[];
  private readonly loop: boolean;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private seq = 0;
  private sink: AudioSink | null = null;
  private sessionId = "";

  constructor(options: SimulatedAudioOptions = {}) {
    this.utterances = options.utterances ?? DEMO_UTTERANCES;
    this.loop = options.loop ?? true;
    this.intervalMs = options.intervalMs ?? AUDIO.frameDurationMs;
  }

  prepare(): void {}

  async start(sessionId: string, sink: AudioSink): Promise<void> {
    await this.stop();
    this.sessionId = sessionId;
    this.sink = sink;
    this.seq = 0;
    const generation = ++this.generation;
    this.timer = setInterval(() => {
      if (generation !== this.generation || !this.sink) return;
      this.sink.onFrame(this.nextFrame());
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sink = null;
  }

  private nextFrame(): AudioFrame {
    const startMs = this.seq * AUDIO.frameDurationMs;
    const speech = utteranceActive(startMs, this.utterances, this.loop);
    const samples = new Int16Array(AUDIO.frameSamples);
    if (speech) {
      for (let i = 0; i < samples.length; i += 1) {
        const n = this.seq * AUDIO.frameSamples + i;
        samples[i] = Math.round(Math.sin(n / 8) * 6_000);
      }
    }
    const rms = computeRms(samples);
    const frame: AudioFrame = {
      sessionId: this.sessionId,
      seq: this.seq,
      startMs,
      durationMs: AUDIO.frameDurationMs,
      sampleRate: AUDIO.sampleRate,
      channels: AUDIO.channels,
      encoding: AUDIO.encoding,
      samples,
      rms,
      speechProbability: speech ? Math.max(0.9, speechProbabilityFromRms(rms)) : speechProbabilityFromRms(rms),
    };
    this.seq += 1;
    return frame;
  }
}

export function simulatedScriptDurationMs(utterances: readonly DemoUtterance[] = DEMO_UTTERANCES): number {
  return scriptCycleMs(utterances);
}
