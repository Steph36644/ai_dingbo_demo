import { spawn, type ChildProcess } from "node:child_process";
import { webcrypto } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { ASR_LANGUAGE, AUDIO } from "@shared/config/defaults";
import { PUNCTUATION_DISPLAY } from "@shared/config/punctuation";
import type { PunctuateResponse, PunctuationMode } from "@shared/contracts/transcript";
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
import { encodeAudioMessage, parseServerMessage, shouldDropForBackpressure, type FunasrServerMessage } from "./funasrProtocol";

export type FunAsrAdapterOptions = {
  python?: string;
  /** Python launcher 的前置参数，例如 Windows py launcher 的 -3。 */
  pythonArgs?: string[];
  scriptPath?: string;
  spawnTimeoutMs?: number;
  /** 等待 start/health。真实模型首次加载远长于端口监听。 */
  readyTimeoutMs?: number;
  /** 单测走骨架，不加载 paraformer。产品默认会加载模型。 */
  stub?: boolean;
};

const STUB_DETAIL = "FunASR sidecar 当前没有在跑。开始盯播才会在 CPU 上加载 paraformer-zh-streaming。";

/**
 * 本地 FunASR 适配器：拉起仅监听 127.0.0.1 的 Python sidecar，
 * 用一次性令牌做 WebSocket 鉴权，并把盯播方言的结果映射成 AsrResult。
 * 默认让 sidecar 在 CPU 上加载 paraformer-zh-streaming；stub 只用于不下载权重的测试。
 */
export class FunAsrAdapter implements AsrAdapter {
  readonly id = "funasr";
  private readonly python: string;
  private readonly pythonArgs: string[];
  private readonly scriptPath: string;
  private readonly usesPythonLauncher: boolean;
  private readonly spawnTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly stub: boolean;
  private child: ChildProcess | null = null;
  private socket: WebSocket | null = null;
  private token = "";
  private started = false;
  private sessionId = "";
  private stderrTail = "";
  private resultListeners = new Set<(result: AsrResult) => void>();
  private errorListeners = new Set<(error: AsrTransportError) => void>();
  private droppedStartMs: number | null = null;

  constructor(options: FunAsrAdapterOptions = {}) {
    this.python = options.python ?? "python3";
    this.pythonArgs = options.pythonArgs ?? [];
    this.scriptPath = options.scriptPath ?? defaultScriptPath();
    this.usesPythonLauncher = this.pythonArgs.includes("-3");
    this.spawnTimeoutMs = options.spawnTimeoutMs ?? 5_000;
    this.stub = options.stub ?? false;
    this.readyTimeoutMs = options.readyTimeoutMs ?? (this.stub ? this.spawnTimeoutMs : 600_000);
  }

  capabilities(): AsrCapabilities {
    return {
      streaming: true,
      partialResults: true,
      wordTimestamps: false,
      inputSampleRates: [AUDIO.sampleRate],
    };
  }

  async checkHealth(): Promise<AsrHealth> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      try {
        await this.start({
          sessionId: "health-check",
          language: ASR_LANGUAGE,
          sampleRate: AUDIO.sampleRate,
        });
        return await this.checkHealth();
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : STUB_DETAIL };
      } finally {
        await this.stop();
      }
    }
    try {
      const message = await this.roundTrip({ type: "health", token: this.token }, "health");
      if (message.type !== "health") return { ok: false, detail: STUB_DETAIL };
      if (!message.ok) return { ok: false, detail: message.detail || STUB_DETAIL };
      return { ok: true, detail: message.detail };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : STUB_DETAIL };
    }
  }

  async start(config: AsrStartConfig): Promise<void> {
    if (config.language !== ASR_LANGUAGE || config.sampleRate !== AUDIO.sampleRate) {
      throw new Error("FunASR 骨架只接受 zh-CN / 16000 Hz");
    }
    if (!existsSync(this.scriptPath)) {
      throw new Error(`找不到 sidecar 脚本：${this.scriptPath}`);
    }
    await this.stop();
    this.token = randomToken();
    this.sessionId = config.sessionId;
    const port = await this.spawnSidecar();
    await this.openSocket(`ws://127.0.0.1:${port}`);
    const ready = await this.roundTrip(
      {
        type: "start",
        token: this.token,
        sessionId: config.sessionId,
        language: ASR_LANGUAGE,
        sampleRate: AUDIO.sampleRate,
        hotwords: config.hotwords,
      },
      "ready",
    );
    if (ready.type === "error") {
      const message = ready.message;
      await this.stop();
      throw new Error(message);
    }
    this.started = true;
  }

  async push(frame: AudioFrame): Promise<void> {
    if (!this.started || !this.socket || frame.sessionId !== this.sessionId) return;
    if (shouldDropForBackpressure(this.socket.bufferedAmount)) {
      if (this.droppedStartMs == null) this.droppedStartMs = frame.startMs;
      this.emitError({
        code: "backpressure",
        message: "FunASR 待发送音频超过 5 秒，已丢弃新帧并进入降级。",
        droppedStartMs: this.droppedStartMs,
        droppedEndMs: frame.startMs + frame.durationMs,
      });
      return;
    }
    this.droppedStartMs = null;
    this.socket.send(encodeAudioMessage(frame));
  }

  async flush(): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "flush", sessionId: this.sessionId }));
  }

  /**
   * 展示层标点。失败时原样退回文本，不抛进识别错误通道。
   * cache 留在 sidecar 会话里；重连后用 reset 清掉旧 cache。
   */
  async punctuate(text: string, mode: PunctuationMode, reset = false): Promise<PunctuateResponse> {
    const requestId = randomToken().slice(0, 12);
    const timeoutMs = mode === "offline" ? PUNCTUATION_DISPLAY.offlineTimeoutMs : PUNCTUATION_DISPLAY.requestTimeoutMs;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return { ok: false, text, mode, detail: "sidecar 未连接" };
    }
    try {
      const message = await this.roundTrip(
        { type: "punctuate", requestId, sessionId: this.sessionId, text, mode, reset },
        "punctuated",
        timeoutMs,
        (item) => item.type === "punctuated" && item.requestId === requestId,
      );
      if (message.type !== "punctuated") {
        return { ok: false, text, mode, detail: "sidecar 返回了意外消息" };
      }
      return {
        ok: message.ok,
        text: typeof message.text === "string" ? message.text : text,
        mode,
        detail: message.detail,
      };
    } catch (error) {
      return { ok: false, text, mode, detail: error instanceof Error ? error.message : "标点失败" };
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "stop", sessionId: this.sessionId }));
      socket.close();
    } else socket?.terminate();
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
          resolve();
        }, 500);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  onResult(listener: (result: AsrResult) => void): () => void {
    this.resultListeners.add(listener);
    return () => this.resultListeners.delete(listener);
  }

  onError(listener: (error: AsrTransportError) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private async spawnSidecar(): Promise<number> {
    const args = [...this.pythonArgs, this.scriptPath, "--host", "127.0.0.1", "--port", "0"];
    if (this.stub) args.push("--stub");
    const child = spawn(this.python, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        ...(this.usesPythonLauncher
          ? {}
          : { PYTHONPATH: [path.dirname(this.scriptPath), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) }),
        FUNASR_SIDECAR_TOKEN: this.token,
        ...(this.stub ? { FUNASR_SIDECAR_STUB: "1" } : {}),
      },
    });
    this.child = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-800);
    });
    child.on("exit", (code) => {
      if (!this.started) return;
      this.emitError({
        code: "disconnected",
        message: `FunASR sidecar 已退出（code=${code ?? "null"}）。${this.stderrTail}`.trim(),
      });
    });
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`sidecar 在 ${this.spawnTimeoutMs}ms 内没有监听成功。${this.stderrTail}`.trim()));
      }, this.spawnTimeoutMs);
      let buffer = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        const match = /SIDECAR listening host=127\.0\.0\.1 port=(\d+)/.exec(buffer);
        if (!match) return;
        clearTimeout(timer);
        resolve(match[1] ?? "");
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`sidecar 提前退出（code=${code ?? "null"}）。${this.stderrTail}`.trim()));
      });
    }).catch(async (error) => {
      await this.stop();
      throw error;
    });
    return Number(line);
  }

  private async openSocket(url: string): Promise<void> {
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.on("message", (data) => {
      this.onSocketMessage(typeof data === "string" ? data : data.toString("utf8"));
    });
    socket.on("error", () => {
      this.emitError({ code: "disconnected", message: "FunASR WebSocket 出错" });
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接 sidecar 超时")), this.spawnTimeoutMs);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new Error("无法连接 sidecar"));
      });
    });
  }

  private onSocketMessage(raw: string): void {
    let message: FunasrServerMessage;
    try {
      message = parseServerMessage(raw);
    } catch (error) {
      this.emitError({
        code: "protocol",
        message: error instanceof Error ? error.message : "无法解析 sidecar 消息",
      });
      return;
    }
    if (message.type === "result") {
      const result: AsrResult = {
        sessionId: message.sessionId,
        providerResultId: message.providerResultId,
        startMs: message.startMs,
        endMs: message.endMs,
        text: message.text,
        isFinal: message.isFinal,
        confidence: message.confidence,
      };
      for (const listener of this.resultListeners) listener(result);
      return;
    }
    if (message.type === "error") {
      this.emitError({
        code: message.code === "unauthorized" ? "unauthorized" : "protocol",
        message: message.message,
      });
    }
  }

  private roundTrip(
    payload: unknown,
    expected: FunasrServerMessage["type"],
    timeoutMs = this.readyTimeoutMs,
    match?: (message: FunasrServerMessage) => boolean,
  ): Promise<FunasrServerMessage> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("sidecar 未连接"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`等待 sidecar ${expected} 超时`));
      }, timeoutMs);
      const onMessage = (data: WebSocket.RawData) => {
        const raw = typeof data === "string" ? data : data.toString("utf8");
        let message: FunasrServerMessage;
        try {
          message = parseServerMessage(raw);
        } catch {
          return;
        }
        if (match) {
          if (!match(message)) return;
        } else if (message.type !== expected && message.type !== "error") return;
        cleanup();
        resolve(message);
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("message", onMessage);
      };
      socket.on("message", onMessage);
      socket.send(JSON.stringify(payload));
    });
  }

  private emitError(error: AsrTransportError): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

function defaultScriptPath(): string {
  const candidates = [
    path.join(process.cwd(), "python/funasr_sidecar/server.py"),
    path.join(__dirname, "../../python/funasr_sidecar/server.py"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  webcrypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
}
