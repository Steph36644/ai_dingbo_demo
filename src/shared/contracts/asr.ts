import type { AudioFrame } from "./audio";

export type AsrId = "fake" | "funasr" | "xfyun";

export type AsrCapabilities = {
  streaming: true;
  partialResults: boolean;
  wordTimestamps: boolean;
  inputSampleRates: number[];
};

export type AsrStartConfig = {
  sessionId: string;
  language: "zh-CN";
  sampleRate: 16000;
  hotwords?: string[];
};

export type AsrResult = {
  sessionId: string;
  providerResultId: string;
  startMs: number;
  endMs: number;
  text: string;
  isFinal: boolean;
  confidence?: number;
  words?: Array<{ text: string; startMs: number; endMs: number }>;
};

export type AsrTransportErrorCode =
  | "health_failed"
  | "disconnected"
  | "backpressure"
  | "timeout"
  | "protocol"
  | "unauthorized";

export type AsrTransportError = {
  code: AsrTransportErrorCode;
  message: string;
  droppedStartMs?: number;
  droppedEndMs?: number;
};

export type AsrHealth = {
  ok: boolean;
  detail?: string;
  /** 主进程为每次预检生成的标识，Renderer 用它丢弃迟到的旧结果。 */
  checkId?: string;
  checkedAt?: string;
};

export interface AsrAdapter {
  readonly id: string;
  capabilities(): AsrCapabilities;
  checkHealth(): Promise<AsrHealth>;
  start(config: AsrStartConfig): Promise<void>;
  push(frame: AudioFrame): Promise<void>;
  flush(): Promise<void>;
  stop(): Promise<void>;
  onResult(listener: (result: AsrResult) => void): () => void;
  onError(listener: (error: AsrTransportError) => void): () => void;
}
