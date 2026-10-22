import { describe, expect, it } from "vitest";
import { TranscriptBuffer } from "../../src/main/transcript/TranscriptBuffer";
import { countEffectiveChars, normalizeText } from "../../src/main/transcript/normalize";
import type { AudioFrame } from "../../src/shared/contracts/audio";
import type { AsrResult } from "../../src/shared/contracts/asr";

function frame(startMs: number, speech: boolean): AudioFrame {
  const samples = new Int16Array(320);
  if (speech) samples.fill(8_000);
  return {
    sessionId: "s",
    seq: startMs / 20,
    startMs,
    durationMs: 20,
    sampleRate: 16000,
    channels: 1,
    encoding: "pcm_s16le",
    samples,
    rms: speech ? 0.2 : 0,
    speechProbability: speech ? 0.9 : 0,
  };
}

function result(partial: Partial<AsrResult> & Pick<AsrResult, "providerResultId" | "text" | "isFinal">): AsrResult {
  return {
    sessionId: "s",
    startMs: 0,
    endMs: 1_000,
    ...partial,
  };
}

describe("normalize", () => {
  it("全角转半角、英文小写，并去掉标点", () => {
    expect(normalizeText("  ＡＢＣ，你好！  ")).toBe("abc 你好");
  });

  it("有效字数忽略标点、纯语气和口吃重复", () => {
    expect(countEffectiveChars("你好，世界！")).toBe(4);
    expect(countEffectiveChars("啊啊啊")).toBe(0);
    expect(countEffectiveChars("嗯。")).toBe(0);
    expect(countEffectiveChars("好好好好好")).toBe(1);
    expect(countEffectiveChars("卖点啊")).toBe(3);
  });
});

describe("TranscriptBuffer", () => {
  it("用新的 partial 替换旧的，final 按 providerResultId 幂等并按时间排序", () => {
    const buffer = new TranscriptBuffer("s");
    buffer.apply(result({ providerResultId: "a", text: "你", isFinal: false, endMs: 200 }));
    buffer.apply(result({ providerResultId: "a", text: "你好", isFinal: false, endMs: 400 }));
    expect(buffer.view().partial?.text).toBe("你好");
    expect(buffer.view().finals).toHaveLength(0);

    buffer.apply(result({ providerResultId: "b", text: "后句", isFinal: true, startMs: 2_000, endMs: 3_000 }));
    buffer.apply(result({ providerResultId: "a", text: "你好，世界", isFinal: true, startMs: 0, endMs: 1_000 }));
    buffer.apply(result({ providerResultId: "a", text: "重复", isFinal: true, startMs: 0, endMs: 1_000 }));

    const view = buffer.view();
    expect(view.partial).toBeNull();
    expect(view.finals.map((segment) => segment.text)).toEqual(["你好，世界", "后句"]);
    expect(view.finals[0]?.normalizedText).toBe("你好 世界");
    expect(view.finals[0]?.text).toBe("你好，世界");
  });

  it("快照是副本，跨窗片段按字符比例裁剪", () => {
    const buffer = new TranscriptBuffer("s");
    buffer.apply(result({ providerResultId: "a", text: "abcdefghij", isFinal: true, startMs: 0, endMs: 1_000 }));
    const snapshot = buffer.snapshot(1_500, 1_000);
    expect(snapshot.windowStartMs).toBe(500);
    expect(snapshot.windowEndMs).toBe(1_500);
    expect(snapshot.segments[0]?.text).toBe("fghij");
    expect(snapshot.segments[0]?.estimatedTiming).toBe(true);
    snapshot.segments[0]!.text = "mutated";
    expect(buffer.view().finals[0]?.text).toBe("abcdefghij");
  });

  it("采音缺口不算静音，也不计入音频覆盖", () => {
    const buffer = new TranscriptBuffer("s");
    buffer.noteFrame(frame(0, true));
    buffer.noteFrame(frame(20, false));
    buffer.noteFrame(frame(3_000, true));
    const snapshot = buffer.snapshot(4_000, 4_000);
    expect(snapshot.gapIntervals).toEqual([{ startMs: 40, endMs: 3_000 }]);
    expect(snapshot.silenceIntervals).toEqual([{ startMs: 20, endMs: 40 }]);
    expect(snapshot.audioCoverageMs).toBe(60);
  });
});
