import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { AUDIO } from "@shared/config/defaults";
import type { AsrResult, AsrTransportError, AsrTransportErrorCode } from "@shared/contracts/asr";
import type { AudioFrame } from "@shared/contracts/audio";
import { redactText } from "../security/redact";

export const XFYUN_RTASR_URL = "wss://rtasr.xfyun.cn/v1/ws";
export const XFYUN_CHUNK_BYTES = 1_280;

export type XfyunCredentials = {
  appId: string;
  apiKey: string;
};

const numericValue = z.union([z.number(), z.string()]).transform((value, context) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "必须是非负有限数字" });
    return z.NEVER;
  }
  return parsed;
});

const resultType = z.union([z.number(), z.string()]).transform((value, context) => {
  const parsed = Number(value);
  if (parsed !== 0 && parsed !== 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "未知转写结果类型" });
    return z.NEVER;
  }
  return parsed;
});

const characterSchema = z
  .object({
    w: z.string(),
    wp: z.string().optional(),
  })
  .passthrough();

const wordSchema = z
  .object({
    cw: z.array(characterSchema),
    wb: numericValue.optional(),
    we: numericValue.optional(),
  })
  .passthrough();

const resultDataSchema = z
  .object({
    cn: z.object({
      st: z
        .object({
          bg: numericValue,
          ed: numericValue,
          rt: z.array(z.object({ ws: z.array(wordSchema) }).passthrough()),
          type: resultType,
        })
        .passthrough(),
    }),
    seg_id: numericValue.refine(Number.isInteger, "seg_id 必须是整数"),
  })
  .passthrough();

const serverMessageSchema = z
  .object({
    action: z.enum(["started", "result", "error"]),
    code: z.string(),
    data: z.string(),
    desc: z.string(),
    sid: z.string().min(1),
  })
  .passthrough();

export type XfyunResultData = z.infer<typeof resultDataSchema>;

export type XfyunServerMessage =
  | { action: "started"; code: string; desc: string; sid: string }
  | { action: "error"; code: string; desc: string; sid: string }
  | { action: "result"; code: string; desc: string; sid: string; result: XfyunResultData };

export function createXfyunSigna(credentials: XfyunCredentials, timestampSeconds: number | string): string {
  const ts = String(timestampSeconds);
  const baseString = `${credentials.appId}${ts}`;
  const digest = createHash("md5").update(baseString, "utf8").digest("hex");
  return createHmac("sha1", credentials.apiKey).update(digest, "utf8").digest("base64");
}

export function createXfyunUrl(credentials: XfyunCredentials, timestampSeconds: number | string): string {
  const ts = String(timestampSeconds);
  const url = new URL(XFYUN_RTASR_URL);
  url.searchParams.set("appid", credentials.appId);
  url.searchParams.set("ts", ts);
  url.searchParams.set("signa", createXfyunSigna(credentials, ts));
  url.searchParams.set("lang", "cn");
  url.searchParams.set("pd", "ecom");
  return url.toString();
}

export function parseXfyunServerMessage(raw: string): XfyunServerMessage {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("讯飞返回了非 JSON 消息");
  }
  const outer = serverMessageSchema.safeParse(json);
  if (!outer.success) throw new Error("讯飞返回消息缺少必要字段或字段类型不正确");
  const message = outer.data;
  if (message.action !== "result") {
    return { action: message.action, code: message.code, desc: message.desc, sid: message.sid };
  }
  let nested: unknown;
  try {
    nested = JSON.parse(message.data);
  } catch {
    throw new Error("讯飞转写结果 data 不是合法 JSON");
  }
  const result = resultDataSchema.safeParse(nested);
  if (!result.success) throw new Error("讯飞转写结果结构不符合 RTASR 协议");
  return {
    action: "result",
    code: message.code,
    desc: message.desc,
    sid: message.sid,
    result: result.data,
  };
}

export function mapXfyunResult(
  message: Extract<XfyunServerMessage, { action: "result" }>,
  sessionId: string,
  connectionOriginMs: number,
  audioEndMs: number,
): AsrResult {
  const statement = message.result.cn.st;
  const words = statement.rt.flatMap((part) => part.ws);
  const text = words.flatMap((word) => word.cw.map((character) => character.w)).join("");
  const isFinal = statement.type === 0;
  const startMs = connectionOriginMs + statement.bg;
  const wordEndMs = words.reduce((latest, word) => {
    if (word.we == null) return latest;
    return Math.max(latest, connectionOriginMs + statement.bg + word.we * 10);
  }, startMs);
  const statedEndMs = connectionOriginMs + statement.ed;
  const endMs = Math.max(
    startMs + AUDIO.frameDurationMs,
    wordEndMs,
    statedEndMs > startMs ? statedEndMs : startMs,
    !isFinal && statement.ed <= statement.bg ? audioEndMs : startMs,
  );
  const timedWords = isFinal
    ? words.flatMap((word) => {
        const wordText = word.cw.map((character) => character.w).join("");
        if (!wordText || word.wb == null || word.we == null || word.we < word.wb) return [];
        return [{
          text: wordText,
          startMs: connectionOriginMs + statement.bg + word.wb * 10,
          endMs: connectionOriginMs + statement.bg + word.we * 10,
        }];
      })
    : [];
  return {
    sessionId,
    providerResultId: `xfyun:${message.sid}:${message.result.seg_id}`,
    startMs,
    endMs,
    text,
    isFinal,
    ...(timedWords.length > 0 ? { words: timedWords } : {}),
  };
}

export class XfyunServiceError extends Error {
  constructor(
    readonly transport: AsrTransportError,
    readonly retryable: boolean,
  ) {
    super(transport.message);
    this.name = "XfyunServiceError";
  }
}

export function classifyXfyunError(code: string): { code: AsrTransportErrorCode; retryable: boolean } {
  if (code === "10105" || code === "10110") return { code: "unauthorized", retryable: false };
  if (code === "10106" || code === "10107") return { code: "protocol", retryable: false };
  return { code: "disconnected", retryable: true };
}

export function xfyunErrorDetail(code: string, desc: string): string {
  if (code === "10105") return "讯飞鉴权失败。请检查 APPID、APIKey、系统时间和 IP 白名单。";
  if (code === "10110") return "讯飞服务未授权或可用路数不足。请检查 RTASR 服务开通、时长和授权。";
  if (code === "37005") return "讯飞超过 15 秒没有收到音频，云端已断开。";
  const safeDesc = redactText(desc).replace(/https?:\/\/\S+/gi, "[url removed]").slice(0, 300);
  return `讯飞 RTASR 错误 ${code || "unknown"}：${safeDesc || "未知错误"}`;
}

/** 把现有 20ms PCM 帧按顺序合成讯飞推荐的 40ms / 1280 字节分片。 */
export class XfyunPcmChunker {
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  get bufferedBytes(): number {
    return this.pendingBytes;
  }

  push(frame: AudioFrame): Buffer[] {
    if (
      frame.durationMs !== AUDIO.frameDurationMs ||
      frame.sampleRate !== AUDIO.sampleRate ||
      frame.channels !== AUDIO.channels ||
      frame.encoding !== AUDIO.encoding
    ) {
      throw new Error("讯飞 RTASR 只接受 20ms / 16kHz / 单声道 PCM S16LE 帧");
    }
    const pcm = Buffer.from(frame.samples.buffer, frame.samples.byteOffset, frame.samples.byteLength);
    if (pcm.length !== AUDIO.frameBytes) throw new Error("讯飞音频帧必须是 640 字节");
    this.pending.push(pcm);
    this.pendingBytes += pcm.length;
    const chunks: Buffer[] = [];
    while (this.pendingBytes >= XFYUN_CHUNK_BYTES) {
      const joined = Buffer.concat(this.pending, this.pendingBytes);
      chunks.push(joined.subarray(0, XFYUN_CHUNK_BYTES));
      const rest = joined.subarray(XFYUN_CHUNK_BYTES);
      this.pending = rest.length > 0 ? [rest] : [];
      this.pendingBytes = rest.length;
    }
    return chunks;
  }

  /** flush 时发送不足 40ms 的尾部音频，避免丢失最后半帧。 */
  drain(): Buffer | null {
    if (this.pendingBytes === 0) return null;
    const rest = Buffer.concat(this.pending, this.pendingBytes);
    this.reset();
    return rest;
  }

  reset(): void {
    this.pending = [];
    this.pendingBytes = 0;
  }
}
