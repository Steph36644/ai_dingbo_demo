import { AUDIO } from "@shared/config/defaults";

export function downmixToMono(interleaved: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return interleaved.slice();
  const frames = Math.floor(interleaved.length / channels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) {
      sum += interleaved[i * channels + c] ?? 0;
    }
    out[i] = sum / channels;
  }
  return out;
}

export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (input.length === 0) return new Float32Array(0);
  if (fromRate === toRate) return input.slice();
  const outLength = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(outLength);
  const scale = fromRate / toRate;
  const last = input.length - 1;
  for (let i = 0; i < outLength; i += 1) {
    const position = i * scale;
    const left = Math.min(last, Math.floor(position));
    const right = Math.min(last, left + 1);
    const weight = position - left;
    const a = input[left] ?? 0;
    const b = input[right] ?? 0;
    out[i] = a * (1 - weight) + b * weight;
  }
  return out;
}

export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767);
  }
  return out;
}

export function computeRms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const normalized = (samples[i] ?? 0) / 32_768;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / samples.length);
}

export function speechProbabilityFromRms(rms: number): number {
  if (rms <= 0) return 0;
  return Math.max(0, Math.min(1, rms / 0.08));
}

export function concatInt16(left: Int16Array, right: Int16Array): Int16Array {
  if (left.length === 0) return right.slice();
  if (right.length === 0) return left.slice();
  const out = new Int16Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

export function isSpeechRms(rms: number): boolean {
  return rms >= AUDIO.speechRmsThreshold;
}
