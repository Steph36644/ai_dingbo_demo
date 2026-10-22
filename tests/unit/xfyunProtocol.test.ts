import { describe, expect, it } from "vitest";
import type { AudioFrame } from "../../src/shared/contracts/audio";
import {
  XFYUN_CHUNK_BYTES,
  XfyunPcmChunker,
  classifyXfyunError,
  createXfyunSigna,
  createXfyunUrl,
  mapXfyunResult,
  parseXfyunServerMessage,
} from "../../src/main/asr/xfyunProtocol";

const credentials = { appId: "595f23df", apiKey: "d9f4aa7ea6d94faca62cd88a28fd5234" };

describe("讯飞 RTASR 协议", () => {
  it("复现官方签名样例并安全编码连接参数", () => {
    expect(createXfyunSigna(credentials, 1512041814)).toBe("IrrzsJeOFk1NGfJHW6SkHUoN9CU=");
    const url = new URL(createXfyunUrl({ appId: "app id", apiKey: "key" }, 123));
    expect(url.protocol).toBe("wss:");
    expect(url.hostname).toBe("rtasr.xfyun.cn");
    expect(url.searchParams.get("appid")).toBe("app id");
    expect(url.searchParams.get("lang")).toBe("cn");
    expect(url.searchParams.get("pd")).toBe("ecom");
    expect(url.searchParams.get("signa")).toBeTruthy();
  });

  it("将两个 20ms 帧合成 40ms / 1280 字节，flush 可 drain 尾部且 reset 不串会话", () => {
    const chunker = new XfyunPcmChunker();
    expect(chunker.push(frame(0, 11))).toEqual([]);
    const chunks = chunker.push(frame(20, 22));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(XFYUN_CHUNK_BYTES);
    expect(chunks[0]?.readInt16LE(0)).toBe(11);
    expect(chunks[0]?.readInt16LE(640)).toBe(22);
    expect(chunker.drain()).toBeNull();

    chunker.push(frame(40, 33));
    expect(chunker.drain()).toHaveLength(640);
    chunker.push(frame(60, 44));
    chunker.reset();
    expect(chunker.drain()).toBeNull();
    expect(chunker.push(frame(80, 55))).toEqual([]);
  });

  it("解析嵌套结果并映射同一 seg_id 的 partial/final、句级和词级时间", () => {
    const partial = resultMessage("1", "820", "0", 5);
    const parsedPartial = parseXfyunServerMessage(JSON.stringify(partial));
    expect(parsedPartial.action).toBe("result");
    if (parsedPartial.action !== "result") throw new Error("expected result");
    const mappedPartial = mapXfyunResult(parsedPartial, "session", 100, 2_000);
    expect(mappedPartial).toMatchObject({
      sessionId: "session",
      providerResultId: "xfyun:rta-test:5",
      startMs: 920,
      endMs: 2_000,
      text: "啊喂！你好！我是，爱新觉罗·李",
      isFinal: false,
    });

    const final = parseXfyunServerMessage(JSON.stringify(resultMessage("0", "820", "1930", 5)));
    if (final.action !== "result") throw new Error("expected result");
    const mappedFinal = mapXfyunResult(final, "session", 100, 2_000);
    expect(mappedFinal.providerResultId).toBe(mappedPartial.providerResultId);
    expect(mappedFinal.startMs).toBe(920);
    expect(mappedFinal.endMs).toBe(2_030);
    expect(mappedFinal.isFinal).toBe(true);
    expect(mappedFinal.words?.[0]).toEqual({ text: "啊", startMs: 920, endMs: 920 });
  });

  it("拒绝畸形消息，区分鉴权、参数和网络错误", () => {
    expect(() => parseXfyunServerMessage("not-json")).toThrow("非 JSON");
    expect(() => parseXfyunServerMessage(JSON.stringify({ action: "result" }))).toThrow("必要字段");
    expect(() => parseXfyunServerMessage(JSON.stringify({ ...resultMessage("1", "0", "20", 1), data: "bad" }))).toThrow("data");
    expect(classifyXfyunError("10105")).toEqual({ code: "unauthorized", retryable: false });
    expect(classifyXfyunError("10110")).toEqual({ code: "unauthorized", retryable: false });
    expect(classifyXfyunError("10106")).toEqual({ code: "protocol", retryable: false });
    expect(classifyXfyunError("10202")).toEqual({ code: "disconnected", retryable: true });
  });
});

function resultMessage(type: string, bg: string, ed: string, segId: number) {
  return {
    action: "result",
    code: "0",
    desc: "success",
    sid: "rta-test",
    data: JSON.stringify({
      cn: {
        st: {
          bg,
          ed,
          type,
          rt: [{
            ws: [
              { cw: [{ w: "啊", wp: "s" }], wb: 0, we: 0 },
              { cw: [{ w: "喂", wp: "n" }], wb: 1, we: 4 },
              { cw: [{ w: "！", wp: "p" }] },
              { cw: [{ w: "你好", wp: "n" }], wb: 5, we: 10 },
              { cw: [{ w: "！", wp: "p" }] },
              { cw: [{ w: "我是", wp: "n" }], wb: 11, we: 20 },
              { cw: [{ w: "，", wp: "p" }] },
              { cw: [{ w: "爱新觉罗·李", wp: "n" }], wb: 21, we: 60 },
            ],
          }],
        },
      },
      seg_id: segId,
    }),
  };
}

function frame(startMs: number, sample: number): AudioFrame {
  const samples = new Int16Array(320);
  samples.fill(sample);
  return {
    sessionId: "sid",
    seq: startMs / 20,
    startMs,
    durationMs: 20,
    sampleRate: 16000,
    channels: 1,
    encoding: "pcm_s16le",
    samples,
    rms: 0.1,
  };
}
