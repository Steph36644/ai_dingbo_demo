import type { AudioFrame, AudioSourceId, PcmChunkPayload } from "@shared/contracts/audio";

export type AudioSink = {
  onFrame: (frame: AudioFrame) => void;
  onCaptureError: (error: { code: string; message: string }) => void;
};

export interface AudioPump {
  readonly id: AudioSourceId;
  /** 为 true 时，会话在 running 期间连续 3 秒无帧会进入 degraded。 */
  readonly monitorsLiveness: boolean;
  prepare(): void;
  start(sessionId: string, sink: AudioSink): Promise<void>;
  stop(): Promise<void>;
  ingest?(chunk: PcmChunkPayload): void;
  failCapture?(message: string): void;
  /** 降级后请求再开采集。不补零，时钟缺口由分帧器记成 gap。 */
  rearm?(): void;
}

export class AudioPumpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AudioPumpError";
  }
}
