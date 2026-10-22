export type AudioEncoding = "pcm_s16le";

export type AudioFrame = {
  sessionId: string;
  seq: number;
  startMs: number;
  durationMs: 20;
  sampleRate: 16000;
  channels: 1;
  encoding: "pcm_s16le";
  samples: Int16Array<ArrayBufferLike>;
  rms: number;
  speechProbability?: number;
};

export type AudioDeviceKind = "loopback" | "output";

export type AudioDeviceInfo = {
  id: string;
  label: string;
  kind: AudioDeviceKind;
  loopbackCapable: boolean;
};

export type LoopbackSupport = "available" | "conditional" | "unavailable";

export type CaptureStrategy = "wasapi-native" | "electron-loopback" | "none";

export type WasapiProbe = {
  available: boolean;
  reason: string;
};

export type DeviceListResult = {
  platform: string;
  support: LoopbackSupport;
  /** 只有 support === "available" 时为 true。conditional 仍可尝试，但不得当成已经成功。 */
  loopbackAvailable: boolean;
  loopbackAttemptAllowed: boolean;
  devices: AudioDeviceInfo[];
  guidance: string;
  captureStrategy: CaptureStrategy;
  wasapiBridge: WasapiProbe;
};

export type AudioSourceId = "loopback" | "simulated" | "stream";

export type PcmChunkPayload = {
  sessionId: string;
  sampleRate: number;
  channels: 1 | 2;
  capturedAtMs: number;
  samples: Float32Array<ArrayBufferLike>;
};
