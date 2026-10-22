import { describe, expect, it } from "vitest";
import { SENTENCE_MAX_CHARS, SENTENCE_MAX_DURATION_MS, presentCaptions, type SentencePiece } from "../../src/shared/transcript/sentences";
import {
  applyPunctuationOverlay,
  mergePunctuationChunk,
  presentPunctuatedCaptions,
  textsAlign,
} from "../../src/shared/transcript/punctuationDisplay";
import type { PunctuationOverlay } from "../../src/shared/contracts/transcript";

function piece(id: string, text: string, startMs: number, endMs: number): SentencePiece {
  return { id, text, startMs, endMs, sourceResultId: id };
}

const dense = [
  piece("a", "今天天气", 0, 600),
  piece("b", "不错", 600, 1_200),
  piece("c", "我们继续讲", 1_200, 1_800),
];

describe("标点展示", () => {
  it("没有覆盖时和现有成句结果一致", () => {
    expect(presentPunctuatedCaptions(dense, null, null)).toEqual(presentCaptions(dense, null));
    const partial = piece("p", "价格", 1_800, 2_000);
    expect(presentPunctuatedCaptions(dense, partial, null)).toEqual(presentCaptions(dense, partial));
  });

  it("句末标点把密讲 final 切成多行，原文片段本身不变", () => {
    const overlay: PunctuationOverlay = {
      sourceIds: ["a", "b", "c"],
      text: "今天天气不错。我们继续讲",
      mode: "realtime",
    };
    const lines = presentPunctuatedCaptions(dense, null, overlay);
    expect(lines.map((line) => line.text)).toEqual(["今天天气不错。", "我们继续讲"]);
    expect(lines.map((line) => line.closed)).toEqual([true, false]);
    expect(lines[1]?.growing).toBe(true);
    expect(dense.map((item) => item.text)).toEqual(["今天天气", "不错", "我们继续讲"]);
  });

  it("保留下一块开头的标点，不把小数点当成句号", () => {
    expect(mergePunctuationChunk("今天天气不错", "。我们继续")).toBe("今天天气不错。我们继续");
    expect(mergePunctuationChunk("今天天气不错", "今天天气不错。我们继续")).toBe("今天天气不错。我们继续");
    const decimal = [piece("a", "到手价3.14元", 0, 600), piece("b", "先看库存", 600, 1_200)];
    const overlay: PunctuationOverlay = {
      sourceIds: ["a", "b"],
      text: "到手价3.14元。先看库存",
      mode: "realtime",
    };
    expect(presentPunctuatedCaptions(decimal, null, overlay).map((line) => line.text)).toEqual([
      "到手价3.14元。",
      "先看库存",
    ]);
    expect(textsAlign("到手价3.14元先看库存", "到手价3.14元。先看库存")).toBe(true);
  });

  it("对不齐或盖不住的覆盖退回原文", () => {
    const mismatch: PunctuationOverlay = {
      sourceIds: ["a", "b", "c"],
      text: "完全不同的句子。",
      mode: "realtime",
    };
    expect(applyPunctuationOverlay(dense, mismatch)).toEqual(dense);
    expect(presentPunctuatedCaptions(dense, null, mismatch)).toEqual(presentCaptions(dense, null));
    const unknown: PunctuationOverlay = { sourceIds: ["missing"], text: "今天天气。", mode: "offline" };
    expect(presentPunctuatedCaptions(dense, null, unknown)).toEqual(presentCaptions(dense, null));
  });

  it("静音间隔仍然切开，标点失败不会把两段粘成一句", () => {
    const gapped = [piece("a", "上一句", 0, 600), piece("b", "下一句", 1_600, 2_200)];
    const overlay: PunctuationOverlay = {
      sourceIds: ["a", "b"],
      text: "上一句，下一句",
      mode: "realtime",
    };
    const lines = presentPunctuatedCaptions(gapped, null, overlay);
    expect(lines.map((line) => line.text)).toEqual(["上一句，", "下一句"]);
    expect(lines[0]?.closed).toBe(true);
    expect(lines[0]?.endMs).toBeLessThan(lines[1]?.startMs ?? 0);
  });

  it("覆盖之后新到的 final 仍按原文接在开放句上", () => {
    const overlay: PunctuationOverlay = {
      sourceIds: ["a", "b"],
      text: "今天天气不错",
      mode: "realtime",
    };
    const lines = presentPunctuatedCaptions(
      [...dense.slice(0, 2), piece("c", "我们继续讲", 1_200, 1_800)],
      null,
      overlay,
    );
    expect(lines.map((line) => line.text)).toEqual(["今天天气不错我们继续讲"]);
    expect(lines[0]?.growing).toBe(true);
  });

  it("只插入逗号时仍按字数和时长软切", () => {
    const byChars = Array.from({ length: 12 }, (_, index) =>
      piece(`c${index}`, "字".repeat(6), index * 200, index * 200 + 180),
    );
    const charText = byChars.map((item) => item.text).join("");
    const charOverlay: PunctuationOverlay = {
      sourceIds: byChars.map((item) => item.id),
      text: `${charText.slice(0, 6)}，${charText.slice(6)}`,
      mode: "realtime",
    };
    const charLines = presentPunctuatedCaptions(byChars, null, charOverlay);
    expect(charLines.length).toBeGreaterThan(1);
    expect(charLines[0]?.closed).toBe(true);
    expect(Array.from(charLines[0]?.text ?? "").length).toBeLessThan(SENTENCE_MAX_CHARS + 6);
    expect(charLines.map((line) => line.text).join("")).toBe(charOverlay.text);

    const byTime = Array.from({ length: 12 }, (_, index) =>
      piece(`t${index}`, "啊", index * 600, (index + 1) * 600),
    );
    const timeOverlay: PunctuationOverlay = {
      sourceIds: byTime.map((item) => item.id),
      text: `啊，${"啊".repeat(11)}`,
      mode: "realtime",
    };
    const timeLines = presentPunctuatedCaptions(byTime, null, timeOverlay);
    expect(timeLines.map((line) => line.text)).toEqual(["啊，" + "啊".repeat(9), "啊啊"]);
    expect(timeLines[0]!.endMs - timeLines[0]!.startMs).toBe(SENTENCE_MAX_DURATION_MS);
    expect(timeLines[1]?.startMs).toBe(SENTENCE_MAX_DURATION_MS);
  });

  it("partial 接在还没标句号的最后一行", () => {
    const overlay: PunctuationOverlay = {
      sourceIds: ["a", "b", "c"],
      text: "今天天气不错。我们继续讲",
      mode: "realtime",
    };
    const lines = presentPunctuatedCaptions(dense, piece("p", "价格", 1_800, 2_000), overlay);
    expect(lines.map((line) => line.text)).toEqual(["今天天气不错。", "我们继续讲价格"]);
    expect(lines[1]?.growing).toBe(true);
  });
});
