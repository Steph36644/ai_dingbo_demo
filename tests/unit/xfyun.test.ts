import { once } from "node:events";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { XfyunAsrAdapter } from "../../src/main/asr/XfyunAsrAdapter";
import { XfyunServiceError } from "../../src/main/asr/xfyunProtocol";
import { AUDIO } from "../../src/shared/config/defaults";
import type { AsrResult, AsrTransportError } from "../../src/shared/contracts/asr";
import type { AudioFrame } from "../../src/shared/contracts/audio";

const credentials = { appId: "test-app-id-secret", apiKey: "test-api-key-secret" };
const servers = new Set<WebSocketServer>();

afterEach(async () => {
  await Promise.all([...servers].map(async (server) => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
  servers.clear();
});

describe("讯飞 RTASR 适配器", () => {
  it("健康检查等待 started，正常关闭不误报，缺少凭据时不联网", async () => {
    const fixture = await createServer((socket) => {
      socket.send(JSON.stringify({ action: "started", code: "0", data: "", desc: "success", sid: "health-sid" }));
    });
    const adapter = new XfyunAsrAdapter({ getCredentials: async () => credentials, socketFactory: fixture.factory });
    await expect(adapter.checkHealth()).resolves.toMatchObject({ ok: true });
    expect(fixture.urls[0]).toContain("appid=test-app-id-secret");

    const missing = new XfyunAsrAdapter({
      getCredentials: async () => null,
      socketFactory: () => {
        throw new Error("不应联网");
      },
    });
    await expect(missing.checkHealth()).resolves.toMatchObject({ ok: false });
  });

  it("发送 1280 字节音频和尾部，映射 partial/final，flush 只发送一次 end", async () => {
    const received: Array<{ binary: boolean; payload: Buffer }> = [];
    const fixture = await createServer((socket) => {
      socket.send(JSON.stringify({ action: "started", code: "0", data: "", desc: "success", sid: "rta-test" }));
      socket.on("message", (payload, binary) => {
        received.push({ binary, payload: Buffer.from(payload as Buffer) });
        if (!binary) {
          socket.send(JSON.stringify(rtasrMessage("0", "0", "40", 0)));
          socket.close();
        }
      });
      setTimeout(() => socket.send(JSON.stringify(rtasrMessage("1", "0", "0", 0))), 10);
    });
    const adapter = new XfyunAsrAdapter({ getCredentials: async () => credentials, socketFactory: fixture.factory, flushTimeoutMs: 1_000 });
    const results: AsrResult[] = [];
    adapter.onResult((result) => results.push(result));
    await adapter.start({ sessionId: "session", language: "zh-CN", sampleRate: 16000 });
    await adapter.push(frame("session", 0));
    await adapter.push(frame("session", 20));
    await waitFor(() => results.length === 1);
    await adapter.flush();
    await adapter.flush();
    await adapter.stop();

    const audio = received.filter((item) => item.binary);
    const control = received.filter((item) => !item.binary);
    expect(audio).toHaveLength(1);
    expect(audio[0]?.payload).toHaveLength(1_280);
    expect(control).toHaveLength(1);
    expect(JSON.parse(control[0]?.payload.toString("utf8") ?? "{}")).toEqual({ end: true });
    expect(results.map((item) => item.isFinal)).toEqual([false, true]);
    expect(results.map((item) => item.providerResultId)).toEqual(["xfyun:rta-test:0", "xfyun:rta-test:0"]);
    expect(results[1]?.text).toBe("欢迎来到直播间");
    expect(JSON.stringify(results)).not.toContain(credentials.appId);
    expect(JSON.stringify(results)).not.toContain(credentials.apiKey);
  });

  it("flush 发送不足 40ms 的尾部，背压和异常断连会通知上层", async () => {
    const received: Buffer[] = [];
    const fixture = await createServer((socket) => {
      socket.send(JSON.stringify({ action: "started", code: "0", data: "", desc: "success", sid: "rta-test" }));
      socket.on("message", (payload, binary) => {
        if (binary) received.push(Buffer.from(payload as Buffer));
      });
    });
    const adapter = new XfyunAsrAdapter({ getCredentials: async () => credentials, socketFactory: fixture.factory, flushTimeoutMs: 30 });
    const errors: AsrTransportError[] = [];
    adapter.onError((error) => errors.push(error));
    await adapter.start({ sessionId: "session", language: "zh-CN", sampleRate: 16000 });
    await adapter.push(frame("session", 0));
    await adapter.flush();
    await adapter.stop();
    expect(received.at(-1)).toHaveLength(640);

    const backpressureFixture = await createServer((socket) => {
      socket.send(JSON.stringify({ action: "started", code: "0", data: "", desc: "success", sid: "rta-test" }));
    });
    const backpressure = new XfyunAsrAdapter({ getCredentials: async () => credentials, socketFactory: backpressureFixture.factory });
    const backpressureErrors: AsrTransportError[] = [];
    backpressure.onError((error) => backpressureErrors.push(error));
    await backpressure.start({ sessionId: "session", language: "zh-CN", sampleRate: 16000 });
    const socket = backpressureFixture.clients[0]!;
    Object.defineProperty(socket, "bufferedAmount", { configurable: true, value: AUDIO.backpressureBytes + 1 });
    await backpressure.push(frame("session", 0));
    expect(backpressureErrors[0]?.code).toBe("backpressure");
    await backpressure.stop();

    const disconnectFixture = await createServer((socket) => {
      socket.send(JSON.stringify({ action: "started", code: "0", data: "", desc: "success", sid: "rta-test" }));
    });
    const disconnect = new XfyunAsrAdapter({ getCredentials: async () => credentials, socketFactory: disconnectFixture.factory });
    const disconnectErrors: AsrTransportError[] = [];
    disconnect.onError((error) => disconnectErrors.push(error));
    await disconnect.start({ sessionId: "session", language: "zh-CN", sampleRate: 16000 });
    disconnectFixture.sockets[0]?.close();
    await waitFor(() => disconnectErrors.length > 0);
    expect(disconnectErrors[0]?.code).toBe("disconnected");
    await disconnect.stop();
  });

  it("握手鉴权失败直接给出可读原因，不进入自动重连事件", async () => {
    const fixture = await createServer((socket) => {
      socket.send(JSON.stringify({ action: "error", code: "10105", data: "", desc: "illegal signa", sid: "rta-test" }));
    });
    const adapter = new XfyunAsrAdapter({ getCredentials: async () => credentials, socketFactory: fixture.factory });
    const errors: AsrTransportError[] = [];
    adapter.onError((error) => errors.push(error));
    let caught: unknown;
    try {
      await adapter.start({ sessionId: "session", language: "zh-CN", sampleRate: 16000 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(XfyunServiceError);
    expect((caught as Error).message).toContain("APPID");
    expect((caught as Error).message).not.toContain(credentials.apiKey);
    expect(errors).toEqual([]);
  });
});

async function createServer(onConnection: (socket: WebSocket) => void) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.add(server);
  const sockets: WebSocket[] = [];
  const clients: WebSocket[] = [];
  const urls: string[] = [];
  server.on("connection", (socket) => {
    sockets.push(socket);
    onConnection(socket);
  });
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    urls,
    sockets,
    clients,
    factory: (url: string) => {
      urls.push(url);
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
      clients.push(socket);
      return socket;
    },
  };
}

function rtasrMessage(type: string, bg: string, ed: string, segId: number) {
  return {
    action: "result",
    code: "0",
    data: JSON.stringify({
      cn: {
        st: {
          bg,
          ed,
          type,
          rt: [{ ws: [{ cw: [{ w: "欢迎来到直播间", wp: "n" }], wb: 0, we: 4 }] }],
        },
      },
      seg_id: segId,
    }),
    desc: "success",
    sid: "rta-test",
  };
}

function frame(sessionId: string, startMs: number): AudioFrame {
  return {
    sessionId,
    seq: startMs / 20,
    startMs,
    durationMs: 20,
    sampleRate: 16000,
    channels: 1,
    encoding: "pcm_s16le",
    samples: new Int16Array(320),
    rms: 0.1,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 3_000) throw new Error("等待模拟讯飞服务超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
