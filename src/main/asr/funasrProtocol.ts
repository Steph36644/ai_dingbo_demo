import { AUDIO } from "@shared/config/defaults";
import type { AudioFrame } from "@shared/contracts/audio";

export type FunasrClientMessage =
  | {
      type: "health";
      token: string;
    }
  | {
      type: "start";
      token: string;
      sessionId: string;
      language: "zh-CN";
      sampleRate: 16000;
      hotwords?: string[];
    }
  | { type: "flush"; sessionId: string }
  | { type: "stop"; sessionId: string }
  | {
      type: "punctuate";
      requestId: string;
      sessionId: string;
      text: string;
      mode: "realtime" | "offline";
      reset?: boolean;
    };

export type FunasrServerMessage =
  | { type: "health"; ok: boolean; model: string; detail: string }
  | { type: "ready"; model: string; detail: string }
  | {
      type: "result";
      sessionId: string;
      providerResultId: string;
      startMs: number;
      endMs: number;
      text: string;
      isFinal: boolean;
      confidence?: number;
    }
  | { type: "error"; code: string; message: string }
  | { type: "stopped" }
  | {
      type: "punctuated";
      requestId: string;
      ok: boolean;
      text: string;
      mode: "realtime" | "offline";
      detail: string;
    };

export type FunasrAudioHeader = {
  type: "audio";
  sessionId: string;
  seq: number;
  startMs: number;
  durationMs: number;
};

export function encodeAudioMessage(frame: AudioFrame): Buffer {
  const header: FunasrAudioHeader = {
    type: "audio",
    sessionId: frame.sessionId,
    seq: frame.seq,
    startMs: frame.startMs,
    durationMs: frame.durationMs,
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length, 0);
  const pcm = Buffer.from(frame.samples.buffer, frame.samples.byteOffset, frame.samples.byteLength);
  return Buffer.concat([length, headerBytes, pcm]);
}

export function decodeAudioMessage(payload: Buffer): { header: FunasrAudioHeader; pcm: Buffer } {
  if (payload.length < 4) throw new Error("音频帧过短");
  const headerLength = payload.readUInt32BE(0);
  if (headerLength <= 0 || headerLength > 64_000 || payload.length < 4 + headerLength) {
    throw new Error("音频帧头长度非法");
  }
  const header = JSON.parse(payload.subarray(4, 4 + headerLength).toString("utf8")) as FunasrAudioHeader;
  if (header.type !== "audio" || header.durationMs !== AUDIO.frameDurationMs) {
    throw new Error("音频帧头不符合 20ms 契约");
  }
  return { header, pcm: payload.subarray(4 + headerLength) };
}

export function parseServerMessage(raw: string): FunasrServerMessage {
  const value = JSON.parse(raw) as FunasrServerMessage;
  if (!value || typeof value !== "object" || typeof value.type !== "string") {
    throw new Error("sidecar 消息缺少 type");
  }
  return value;
}

export function shouldDropForBackpressure(bufferedBytes: number, maxBytes = AUDIO.backpressureBytes): boolean {
  return bufferedBytes > maxBytes;
}
