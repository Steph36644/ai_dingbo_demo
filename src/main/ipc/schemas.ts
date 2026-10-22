import { z } from "zod";
import type { PcmChunkPayload } from "@shared/contracts/audio";
import type { MarkReadRequest } from "@shared/contracts/issue";
import { isReplaySessionId, type SessionRenameRequest } from "@shared/contracts/replay";
import type { SessionStartOptions } from "@shared/contracts/session";
import type { StageSetRequest } from "@shared/contracts/ipc";
import type { StageOpenRequest } from "@shared/contracts/display";
import { normalizeDouyinLiveUrl } from "@shared/live/douyin";

export const sessionStartSchema = z.object({
  audioSource: z.enum(["loopback", "simulated", "stream"]),
  asrId: z.enum(["fake", "funasr", "xfyun"]),
  demoScript: z.enum(["standard", "issues"]).optional(),
  streamUrl: z.string().max(512).optional(),
});

const settingsTimingSchema = z
  .object({
    windowMs: z.number(),
    intervalMs: z.number(),
    streamAudible: z.boolean().optional(),
  })
  .strict();

const settingsAudibleSchema = z
  .object({
    streamAudible: z.boolean(),
  })
  .strict();

export const settingsUpdateSchema = z.union([settingsTimingSchema, settingsAudibleSchema]);

export type SettingsUpdateInput =
  | { windowMs: number; intervalMs: number; streamAudible?: boolean }
  | { streamAudible: boolean };

export const secretSetSchema = z
  .object({
    key: z.string().min(1).max(512),
  })
  .strict();

export const xfyunSecretSetSchema = z
  .object({
    appId: z.string().trim().min(1).max(128),
    apiKey: z.string().min(1).max(512),
  })
  .strict();

export const markReadSchema = z.union([
  z.object({ id: z.string().min(1).max(80) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

export const asrIdSchema = z.enum(["fake", "funasr", "xfyun"]);

export const captureFailedSchema = z.object({
  sessionId: z.string().min(1).max(80),
  message: z.string().min(1).max(500),
});

export const stageOpenSchema = z
  .object({
    displayId: z.number().int(),
    mode: z.enum(["window", "fullscreen"]),
  })
  .strict();

export const stageSetSchema = z.union([
  z.object({ stageId: z.string().min(1).max(80) }).strict(),
  z.object({ pinIssueId: z.string().min(1).max(80) }).strict(),
  z.object({ dismissIssueId: z.string().min(1).max(80) }).strict(),
  z.object({ clearPin: z.literal(true) }).strict(),
  z.object({ productNote: z.string().max(500).nullable() }).strict(),
]);

export const stagePreferencesSchema = z
  .object({
    displayId: z.number().int().nullable(),
    mode: z.enum(["window", "fullscreen"]),
  })
  .strict();

export const sessionRenameSchema = z
  .object({
    sessionId: z.string().refine(isReplaySessionId, { message: "sessionId 不合法" }),
    title: z.string().max(60),
  })
  .strict();

export function parseSessionStart(input: unknown): SessionStartOptions | null {
  const parsed = sessionStartSchema.safeParse(input);
  if (!parsed.success) return null;
  if (parsed.data.audioSource !== "stream") {
    return parsed.data.streamUrl === undefined ? parsed.data : null;
  }
  const normalized = normalizeDouyinLiveUrl(parsed.data.streamUrl ?? "");
  if (!normalized.ok) return null;
  return { ...parsed.data, streamUrl: normalized.url };
}

export function parseSettingsUpdate(input: unknown): SettingsUpdateInput | null {
  const parsed = settingsUpdateSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function parseSecretSet(input: unknown): { key: string } | null {
  const parsed = secretSetSchema.safeParse(input);
  if (!parsed.success) return null;
  if (/[\u0000-\u001f\u007f]/.test(parsed.data.key)) return null;
  return { key: parsed.data.key };
}

export function parseXfyunSecretSet(input: unknown): { appId: string; apiKey: string } | null {
  const parsed = xfyunSecretSetSchema.safeParse(input);
  if (!parsed.success) return null;
  if (/[\u0000-\u001f\u007f]/.test(parsed.data.appId) || /[\u0000-\u001f\u007f]/.test(parsed.data.apiKey)) return null;
  return parsed.data;
}

export function parseMarkRead(input: unknown): MarkReadRequest | null {
  const parsed = markReadSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function parseReplaySessionId(input: unknown): string | null {
  if (typeof input !== "string" || !isReplaySessionId(input)) return null;
  return input;
}

export function parseAsrId(input: unknown): "fake" | "funasr" | "xfyun" | null {
  const parsed = asrIdSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function parseCaptureFailed(input: unknown): { sessionId: string; message: string } | null {
  const parsed = captureFailedSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function parseStageOpen(input: unknown): StageOpenRequest | null {
  const parsed = stageOpenSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function parseStageSet(input: unknown): StageSetRequest | null {
  const parsed = stageSetSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function parseSessionRename(input: unknown): SessionRenameRequest | null {
  const parsed = sessionRenameSchema.safeParse(input);
  if (!parsed.success) return null;
  // 去掉控制字符，避免 JSONL 行被打断
  if (/[\u0000-\u001f\u007f]/.test(parsed.data.title)) return null;
  return { sessionId: parsed.data.sessionId, title: parsed.data.title };
}

export function parseAudioChunk(input: unknown): PcmChunkPayload | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Partial<PcmChunkPayload>;
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0 || value.sessionId.length > 80) return null;
  if (typeof value.sampleRate !== "number" || value.sampleRate < 8_000 || value.sampleRate > 96_000) return null;
  if (value.channels !== 1 && value.channels !== 2) return null;
  if (typeof value.capturedAtMs !== "number" || !Number.isFinite(value.capturedAtMs) || value.capturedAtMs < 0) return null;
  const samples = asFloat32(value.samples);
  if (!samples) return null;
  return {
    sessionId: value.sessionId,
    sampleRate: value.sampleRate,
    channels: value.channels,
    capturedAtMs: value.capturedAtMs,
    samples,
  };
}

function asFloat32(value: unknown): Float32Array | null {
  if (value instanceof Float32Array) return value.length > 0 && value.length <= 96_000 * 2 ? value : null;
  if (value instanceof ArrayBuffer) return asFloat32(new Float32Array(value));
  if (!Array.isArray(value) || value.length === 0 || value.length > 96_000 * 2) return null;
  if (!value.every((item) => typeof item === "number" && Number.isFinite(item))) return null;
  return Float32Array.from(value);
}

