import { AUDIO } from "@shared/config/defaults";
import type { AudioFrame } from "@shared/contracts/audio";
import { computeRms, concatInt16, downmixToMono, floatToInt16, resampleLinear, speechProbabilityFromRms } from "./pcm";

export type RawPcmChunk = {
  sampleRate: number;
  channels: number;
  capturedAtMs: number;
  samples: Float32Array;
};

/**
 * 把任意采样率的浮点 PCM 收成 16 kHz / mono / S16LE / 20 ms 帧。
 * 时钟跳变只记缺口，不插零，避免把采音中断算进静音。
 */
export class PcmFramer {
  private seq = 0;
  private pending: Int16Array<ArrayBufferLike> = new Int16Array(0);
  private nextStartMs: number | null = null;

  constructor(private readonly sessionId: string) {}

  push(chunk: RawPcmChunk): AudioFrame[] {
    if (!Number.isFinite(chunk.sampleRate) || chunk.sampleRate <= 0) return [];
    const mono = downmixToMono(chunk.samples, Math.max(1, chunk.channels));
    const resampled = resampleLinear(mono, chunk.sampleRate, AUDIO.sampleRate);
    const pcm = floatToInt16(resampled);
    const capturedAt = Math.max(0, Math.round(chunk.capturedAtMs));

    if (this.nextStartMs == null) {
      this.nextStartMs = capturedAt;
    } else if (capturedAt > this.nextStartMs + AUDIO.gapToleranceMs) {
      this.pending = new Int16Array(0);
      this.nextStartMs = capturedAt;
    }

    this.pending = concatInt16(this.pending, pcm);
    const frames: AudioFrame[] = [];
    while (this.pending.length >= AUDIO.frameSamples) {
      const samples = this.pending.slice(0, AUDIO.frameSamples);
      this.pending = this.pending.slice(AUDIO.frameSamples);
      const startMs: number = this.nextStartMs ?? 0;
      this.nextStartMs = startMs + AUDIO.frameDurationMs;
      const rms = computeRms(samples);
      frames.push({
        sessionId: this.sessionId,
        seq: this.seq,
        startMs,
        durationMs: AUDIO.frameDurationMs,
        sampleRate: AUDIO.sampleRate,
        channels: AUDIO.channels,
        encoding: AUDIO.encoding,
        samples,
        rms,
        speechProbability: speechProbabilityFromRms(rms),
      });
      this.seq += 1;
    }
    return frames;
  }
}
