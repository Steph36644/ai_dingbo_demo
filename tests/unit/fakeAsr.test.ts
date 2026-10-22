import { describe, expect, it } from "vitest";
import { FakeAsrAdapter } from "../../src/main/asr/FakeAsrAdapter";
import type { AudioFrame } from "../../src/shared/contracts/audio";
import type { AsrResult } from "../../src/shared/contracts/asr";

const SCRIPT = [
  { startMs: 0, endMs: 1_000, text: "你好世界" },
  { startMs: 1_000, endMs: 2_000, text: "活动价" },
] as const;

function frame(startMs: number): AudioFrame {
  return {
    sessionId: "s",
    seq: startMs / 20,
    startMs,
    durationMs: 20,
    sampleRate: 16000,
    channels: 1,
    encoding: "pcm_s16le",
    samples: new Int16Array(320),
    rms: 0,
  };
}

async function pushUntil(asr: FakeAsrAdapter, endMs: number): Promise<void> {
  for (let time = 0; time < endMs; time += 20) {
    await asr.push(frame(time));
  }
}

describe("Fake ASR", () => {
  it("同一时钟得到确定的 partial，到点后只给一次 final", async () => {
    const asr = new FakeAsrAdapter({ utterances: SCRIPT, loop: false });
    const results: AsrResult[] = [];
    asr.onResult((result) => results.push(result));
    await asr.start({ sessionId: "s", language: "zh-CN", sampleRate: 16000 });

    await pushUntil(asr, 500);
    const partials = results.filter((item) => !item.isFinal && item.providerResultId === "fake-0-0");
    expect(partials.at(-1)?.text).toBe("你好");
    expect(results.some((item) => item.isFinal)).toBe(false);

    await pushUntil(asr, 1_000);
    const finals = results.filter((item) => item.isFinal && item.providerResultId === "fake-0-0");
    expect(finals).toHaveLength(1);
    expect(finals[0]?.text).toBe("你好世界");

    await asr.push(frame(980));
    expect(results.filter((item) => item.isFinal && item.providerResultId === "fake-0-0")).toHaveLength(1);
    await asr.stop();
  });

  it("flush 把已经开始的一句收成 final，不提前写出还没到的句子", async () => {
    const asr = new FakeAsrAdapter({ utterances: SCRIPT, loop: false });
    const results: AsrResult[] = [];
    asr.onResult((result) => results.push(result));
    await asr.start({ sessionId: "s", language: "zh-CN", sampleRate: 16000 });
    await pushUntil(asr, 200);
    await asr.flush();
    const finals = results.filter((item) => item.isFinal);
    expect(finals.map((item) => item.providerResultId)).toEqual(["fake-0-0"]);
    expect(finals[0]?.text.startsWith("你")).toBe(true);
    expect(finals[0]?.text).not.toBe("活动价");
  });
});
