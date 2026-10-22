import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { FunAsrAdapter } from "../../src/main/asr/FunAsrAdapter";
import { decodeAudioMessage, encodeAudioMessage, shouldDropForBackpressure } from "../../src/main/asr/funasrProtocol";
import { AUDIO } from "../../src/shared/config/defaults";
import type { AudioFrame } from "../../src/shared/contracts/audio";
import type { AsrResult } from "../../src/shared/contracts/asr";
import { pythonArgs, pythonCommand, pythonEnv } from "../helpers/python";

function frame(seq: number): AudioFrame {
  const samples = new Int16Array(AUDIO.frameSamples);
  samples[0] = 1234;
  return {
    sessionId: "sid",
    seq,
    startMs: seq * 20,
    durationMs: 20,
    sampleRate: 16000,
    channels: 1,
    encoding: "pcm_s16le",
    samples,
    rms: 0,
  };
}

describe("FunASR 协议", () => {
  it("适配器把骨架结果映射成 AsrResult，不泄露连接令牌", async () => {
    const python = pythonCommand();
    const adapter = new FunAsrAdapter({ stub: true, python: python.command, pythonArgs: python.prefix });
    const results: AsrResult[] = [];
    adapter.onResult((result) => results.push(result));
    await adapter.start({ sessionId: "sid", language: "zh-CN", sampleRate: 16000 });
    try {
      for (let seq = 0; seq < 25; seq += 1) await adapter.push(frame(seq));
      await waitFor(() => results.some((item) => item.text.includes("未加载模型")));
      expect(results[0]?.sessionId).toBe("sid");
      expect(JSON.stringify(results)).not.toMatch(/test-token|[0-9a-f]{32}/);
      const punctuated = await adapter.punctuate("今天天气不错", "realtime");
      expect(punctuated).toMatchObject({ ok: false, text: "今天天气不错", mode: "realtime" });
      expect(punctuated.detail).toContain("未加载标点模型");
    } finally {
      await adapter.stop();
    }
  });

  it("未连接时健康预检会拉起 sidecar，确认模型就绪后回收进程", async () => {
    const python = pythonCommand();
    const adapter = new FunAsrAdapter({ stub: true, python: python.command, pythonArgs: python.prefix });
    await expect(adapter.checkHealth()).resolves.toMatchObject({ ok: true });
    await expect(adapter.checkHealth()).resolves.toMatchObject({ ok: true });
    const missing = new FunAsrAdapter({
      stub: true,
      python: python.command,
      pythonArgs: python.prefix,
      scriptPath: "python/funasr_sidecar/not-found.py",
    });
    await expect(missing.checkHealth()).resolves.toMatchObject({ ok: false });
  });

  it("音频帧可以来回解析，超过 5 秒缓冲就丢弃", () => {
    const encoded = encodeAudioMessage(frame(3));
    const decoded = decodeAudioMessage(encoded);
    expect(decoded.header).toMatchObject({ type: "audio", sessionId: "sid", seq: 3, startMs: 60, durationMs: 20 });
    expect(decoded.pcm.readInt16LE(0)).toBe(1234);
    expect(shouldDropForBackpressure(AUDIO.backpressureBytes)).toBe(false);
    expect(shouldDropForBackpressure(AUDIO.backpressureBytes + 1)).toBe(true);
  });

  it("sidecar 只在回环地址提供骨架结果", async () => {
    const refusedPython = pythonArgs(["python/funasr_sidecar/server.py", "--host", "0.0.0.0", "--port", "0", "--token", "nope"]);
    const refused = spawn(refusedPython.command, refusedPython.args, { env: pythonEnv() });
    const [code] = (await once(refused, "exit")) as [number | null];
    expect(code).toBe(2);

    const childPython = pythonArgs(["python/funasr_sidecar/server.py", "--host", "127.0.0.1", "--port", "0", "--token", "test-token", "--stub"]);
    const child = spawn(
      childPython.command,
      childPython.args,
      { stdio: ["ignore", "pipe", "pipe"], env: pythonEnv() },
    );
    let output = "";
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sidecar 没有监听：${output}`)), 5_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        const match = /port=(\d+)/.exec(output);
        if (!match?.[1]) return;
        clearTimeout(timer);
        resolve(Number(match[1]));
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`sidecar 退出：${output}`));
      });
    });

    try {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      await once(socket, "open");
      const messages: Array<Record<string, unknown>> = [];
      socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
      socket.send(JSON.stringify({ type: "health", token: "wrong" }));
      await waitFor(() => messages.some((item) => item.code === "unauthorized"));
      socket.send(JSON.stringify({ type: "start", token: "test-token", sessionId: "sid", language: "zh-CN", sampleRate: 16000 }));
      await waitFor(() => messages.some((item) => item.type === "ready"));
      socket.send(JSON.stringify({
        type: "punctuate",
        requestId: "p1",
        sessionId: "sid",
        text: "今天天气不错",
        mode: "realtime",
        reset: false,
      }));
      await waitFor(() => messages.some((item) => item.type === "punctuated"));
      expect(messages.find((item) => item.type === "punctuated")).toMatchObject({
        requestId: "p1",
        ok: false,
        text: "今天天气不错",
        mode: "realtime",
        detail: "未加载标点模型",
      });
      for (let seq = 0; seq < 25; seq += 1) socket.send(encodeAudioMessage(frame(seq)));
      await waitFor(() => messages.some((item) => item.type === "result" && String(item.text).includes("未加载模型")));
      const result = messages.find((item) => item.type === "result");
      expect(result?.isFinal).toBe(false);
      socket.close();
    } finally {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 5_000) throw new Error("等待 sidecar 消息超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
