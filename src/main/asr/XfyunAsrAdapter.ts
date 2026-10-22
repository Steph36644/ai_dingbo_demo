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
import WebSocket from "ws";
import { shouldDropForBackpressure } from "./funasrProtocol";
import { redactText } from "../security/redact";
import {
  XfyunPcmChunker,
  XfyunServiceError,
  classifyXfyunError,
  createXfyunUrl,
  mapXfyunResult,
  parseXfyunServerMessage,
  xfyunErrorDetail,
  type XfyunCredentials,
  type XfyunServerMessage,
} from "./xfyunProtocol";

export type XfyunSocketFactory = (url: string) => WebSocket;

export type XfyunAsrAdapterOptions = {
  getCredentials: () => Promise<XfyunCredentials | null>;
  connectTimeoutMs?: number;
  flushTimeoutMs?: number;
  now?: () => number;
  socketFactory?: XfyunSocketFactory;
};

/** 主进程内的讯飞 RTASR 标准版适配器。凭据、签名 URL 和原始结果不离开本模块。 */
export class XfyunAsrAdapter implements AsrAdapter {
  readonly id = "xfyun";
  private readonly getCredentials: () => Promise<XfyunCredentials | null>;
  private readonly connectTimeoutMs: number;
  private readonly flushTimeoutMs: number;
  private readonly now: () => number;
  private readonly socketFactory: XfyunSocketFactory;
  private socket: WebSocket | null = null;
  private sessionId = "";
  private connectionOriginMs: number | null = null;
  private audioEndMs = 0;
  private lastFrameStartMs: number | null = null;
  private chunker = new XfyunPcmChunker();
  private started = false;
  private flushing = false;
  private stopping = false;
  private endSent = false;
  private sawFinalResult = false;
  private terminalError: AsrTransportError | null = null;
  private partialProviderId: string | null = null;
  private droppedStartMs: number | null = null;
  private resultListeners = new Set<(result: AsrResult) => void>();
  private errorListeners = new Set<(error: AsrTransportError) => void>();

  constructor(options: XfyunAsrAdapterOptions) {
    this.getCredentials = options.getCredentials;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.flushTimeoutMs = options.flushTimeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
  }

  capabilities(): AsrCapabilities {
    return {
      streaming: true,
      partialResults: true,
      wordTimestamps: true,
      inputSampleRates: [AUDIO.sampleRate],
    };
  }

  async checkHealth(): Promise<AsrHealth> {
    const credentials = await this.getCredentials();
    if (!credentials) return { ok: false, detail: "还没有配置讯飞 APPID 和 APIKey。" };
    let socket: WebSocket | null = null;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    return new Promise<AsrHealth>((resolve) => {
      const finish = (health: AsrHealth) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const current = socket;
        socket = null;
        if (current && current.readyState === WebSocket.OPEN) current.close();
        else current?.terminate();
        resolve(health);
      };
      timer = setTimeout(() => finish({ ok: false, detail: "连接讯飞 RTASR 健康检查超时。" }), this.connectTimeoutMs);
      try {
        const url = createXfyunUrl(credentials, Math.floor(this.now() / 1000));
        socket = this.socketFactory(url);
        socket.on("message", (data) => {
          let message: XfyunServerMessage;
          try {
            message = parseXfyunServerMessage(rawText(data));
          } catch (error) {
            finish({ ok: false, detail: safeError(error, "讯飞健康检查返回了无法解析的消息。") });
            return;
          }
          if (message.action === "started") {
            finish({ ok: true, detail: "讯飞 RTASR 云端握手成功，凭据和服务授权可用。" });
            return;
          }
          if (message.action === "error") finish({ ok: false, detail: xfyunErrorDetail(message.code, message.desc) });
        });
        socket.on("error", () => finish({ ok: false, detail: "无法连接讯飞 RTASR，请检查网络和代理。" }));
        socket.on("close", () => finish({ ok: false, detail: "讯飞 RTASR 在健康检查完成前关闭了连接。" }));
      } catch (error) {
        finish({ ok: false, detail: safeError(error, "无法发起讯飞健康检查。") });
      }
    });
  }

  async start(config: AsrStartConfig): Promise<void> {
    if (config.language !== ASR_LANGUAGE || config.sampleRate !== AUDIO.sampleRate) {
      throw new Error("讯飞 RTASR 适配器只接受 zh-CN / 16000 Hz");
    }
    await this.stop();
    const credentials = await this.getCredentials();
    if (!credentials?.appId || !credentials.apiKey) throw new Error("请先在设置中配置讯飞 APPID 和 APIKey。");
    this.sessionId = config.sessionId;
    this.connectionOriginMs = null;
    this.audioEndMs = 0;
    this.lastFrameStartMs = null;
    this.chunker.reset();
    this.droppedStartMs = null;
    this.endSent = false;
    this.sawFinalResult = false;
    this.terminalError = null;
    this.partialProviderId = null;
    this.flushing = false;
    this.stopping = false;
    const socket = this.socketFactory(createXfyunUrl(credentials, Math.floor(this.now() / 1000)));
    this.socket = socket;
    try {
      this.bindSocket(socket);
      await this.awaitStarted(socket);
      this.started = true;
    } catch (error) {
      await this.stop();
      if (error instanceof XfyunServiceError && !error.retryable) {
        this.terminalError = error.transport;
      }
      throw error;
    }
  }

  async push(frame: AudioFrame): Promise<void> {
    if (this.terminalError) throw new XfyunServiceError(this.terminalError, false);
    if (!this.started || this.flushing || frame.sessionId !== this.sessionId) return;
    if (this.lastFrameStartMs != null && frame.startMs < this.lastFrameStartMs) {
      throw new Error("讯飞 RTASR 不支持在连接中回退音频时钟；请重连后从新音频继续。");
    }
    this.lastFrameStartMs = frame.startMs;
    this.audioEndMs = Math.max(this.audioEndMs, frame.startMs + frame.durationMs);
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.fail({ code: "disconnected", message: "讯飞 RTASR 连接已断开。" }, true);
      return;
    }
    if (shouldDropForBackpressure(socket.bufferedAmount + this.chunker.bufferedBytes)) {
      if (this.droppedStartMs == null) this.droppedStartMs = frame.startMs;
      this.fail({
        code: "backpressure",
        message: "讯飞 RTASR 待发送音频超过 5 秒，已丢弃新帧并进入降级。",
        droppedStartMs: this.droppedStartMs,
        droppedEndMs: frame.startMs + frame.durationMs,
      }, true);
      return;
    }
    this.droppedStartMs = null;
    const chunks = this.chunker.push(frame);
    for (const chunk of chunks) socket.send(chunk, { binary: true });
  }

  async flush(): Promise<void> {
    if (this.terminalError) throw new XfyunServiceError(this.terminalError, false);
    if (!this.started || this.endSent) return;
    this.flushing = true;
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const tail = this.chunker.drain();
    if (tail) socket.send(tail, { binary: true });
    socket.send(JSON.stringify({ end: true }));
    this.endSent = true;
    const pendingPartial = this.partialProviderId;
    if (pendingPartial == null && this.sawFinalResult) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("close", onSettled);
        socket.off("error", onSettled);
        socket.off("message", onMessage);
        resolve();
      };
      const onSettled = () => cleanup();
      const onMessage = (data: WebSocket.RawData) => {
        try {
          const message = parseXfyunServerMessage(rawText(data));
          if (message.action !== "result" || message.result.cn.st.type !== 0) return;
          if (pendingPartial == null || `xfyun:${message.sid}:${message.result.seg_id}` === pendingPartial) cleanup();
        } catch {
          // bindSocket 会统一上报协议错误；这里只负责等待收尾。
        }
      };
      const timer = setTimeout(cleanup, this.flushTimeoutMs);
      socket.once("close", onSettled);
      socket.once("error", onSettled);
      socket.on("message", onMessage);
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    this.flushing = false;
    this.chunker.reset();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners("message");
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
      else socket.terminate();
    }
    this.endSent = false;
    this.sawFinalResult = false;
    this.terminalError = null;
    this.partialProviderId = null;
  }

  onResult(listener: (result: AsrResult) => void): () => void {
    this.resultListeners.add(listener);
    return () => this.resultListeners.delete(listener);
  }

  onError(listener: (error: AsrTransportError) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private awaitStarted(socket: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("message", onMessage);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onMessage = (data: WebSocket.RawData) => {
        let message: XfyunServerMessage;
        try {
          message = parseXfyunServerMessage(rawText(data));
        } catch (error) {
          finish(error instanceof Error ? error : new Error("无法解析讯飞握手消息"));
          return;
        }
        if (message.action === "started") finish();
        else if (message.action === "error") finish(serviceError(message.code, message.desc));
      };
      const onError = () => finish(new Error("无法连接讯飞 RTASR，请检查网络和代理。"));
      const onClose = () => finish(new Error("讯飞 RTASR 在握手完成前关闭了连接。"));
      const timer = setTimeout(() => finish(new Error("连接讯飞 RTASR 超时。")), this.connectTimeoutMs);
      socket.on("message", onMessage);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
  }

  private bindSocket(socket: WebSocket): void {
    socket.on("message", (data) => {
      let message: XfyunServerMessage;
      try {
        message = parseXfyunServerMessage(rawText(data));
      } catch (error) {
        this.fail({ code: "protocol", message: safeError(error, "无法解析讯飞 RTASR 消息。") }, true);
        return;
      }
      if (message.action === "result") {
        if (this.connectionOriginMs == null) this.connectionOriginMs = Math.max(0, this.audioEndMs - message.result.cn.st.bg);
        const result = mapXfyunResult(message, this.sessionId, this.connectionOriginMs, this.audioEndMs);
        if (!result.text) return;
        if (!result.isFinal) this.partialProviderId = result.providerResultId;
        else this.sawFinalResult = true;
        for (const listener of this.resultListeners) listener(result);
        if (result.isFinal && this.partialProviderId === result.providerResultId) this.partialProviderId = null;
        return;
      }
      if (message.action === "error") {
        const classified = classifyXfyunError(message.code);
        this.fail({ code: classified.code, message: xfyunErrorDetail(message.code, message.desc) }, classified.retryable);
      }
    });
    socket.on("error", () => {
      if (this.endSent || this.stopping) return;
      this.fail({ code: "disconnected", message: "讯飞 RTASR WebSocket 连接出错。" }, true);
    });
    socket.on("close", () => {
      if (this.endSent || this.stopping || this.socket !== socket) return;
      this.fail({ code: "disconnected", message: "讯飞 RTASR 连接意外关闭。" }, true);
    });
  }

  private fail(error: AsrTransportError, retryable: boolean): void {
    if (!retryable) {
      this.terminalError = error;
      return;
    }
    this.started = false;
    for (const listener of this.errorListeners) listener(error);
  }
}

function serviceError(code: string, desc: string): XfyunServiceError {
  const classified = classifyXfyunError(code);
  return new XfyunServiceError({ code: classified.code, message: xfyunErrorDetail(code, desc) }, classified.retryable);
}

function rawText(data: WebSocket.RawData): string {
  return typeof data === "string" ? data : data.toString("utf8");
}

function safeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? redactText(error.message).slice(0, 300) : fallback;
}
