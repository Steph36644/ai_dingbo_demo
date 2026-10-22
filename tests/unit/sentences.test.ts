import { describe, expect, it } from "vitest";
import {
  SENTENCE_GAP_MS,
  SENTENCE_MAX_CHARS,
  SENTENCE_MAX_DURATION_MS,
  aggregateSentences,
  presentCaptions,
  type SentencePiece,
} from "../../src/shared/transcript/sentences";

function piece(
  id: string,
  text: string,
  startMs: number,
  endMs: number,
  sourceResultId?: string,
): SentencePiece {
  return { id, text, startMs, endMs, sourceResultId };
}

/** 连续汉字，每个都是一个 Unicode 码点，不含标点。 */
function chars(count: number, seed = 0): string {
  let out = "";
  for (let index = 0; index < count; index += 1) out += String.fromCodePoint(0x4e00 + ((seed + index) % 40));
  return out;
}

describe("成句聚合", () => {
  it("静音阈值落在 0.6–1.0 秒", () => {
    expect(SENTENCE_GAP_MS).toBeGreaterThanOrEqual(600);
    expect(SENTENCE_GAP_MS).toBeLessThanOrEqual(1_000);
  });

  it("句末标点收束，下一片段另起一句", () => {
    const lines = aggregateSentences([
      piece("a", "今天天气", 0, 600),
      piece("b", "不错。", 600, 1_200),
      piece("c", "我们", 1_200, 1_800),
      piece("d", "继续讲", 1_800, 2_400),
    ]);
    expect(lines.map((line) => line.text)).toEqual(["今天天气不错。", "我们继续讲"]);
    expect(lines.map((line) => line.closed)).toEqual([true, false]);
    expect(lines[0]?.sources.map((item) => item.id)).toEqual(["a", "b"]);
    expect(lines[1]?.sources.map((item) => item.id)).toEqual(["c", "d"]);
  });

  it("。！？!?；;… 和英文省略号都会收束", () => {
    for (const mark of ["。", "！", "？", "!", "?", "；", ";", "…", "..."]) {
      const lines = aggregateSentences([
        piece("a", `先说完${mark}`, 0, 600),
        piece("b", "后一句", 600, 1_200),
      ]);
      expect(lines.map((line) => line.text)).toEqual([`先说完${mark}`, "后一句"]);
      expect(lines[0]?.closed).toBe(true);
    }
  });

  it("段间静音达到阈值就切开，短于阈值的空隙仍拼在一起", () => {
    const merged = aggregateSentences([
      piece("a", "还在说", 0, 600),
      piece("b", "同一句", 600 + SENTENCE_GAP_MS - 1, 1_200 + SENTENCE_GAP_MS),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe("还在说同一句");
    expect(merged[0]?.closed).toBe(false);

    const split = aggregateSentences([
      piece("a", "上一句", 0, 600),
      piece("b", "没有标点", 600, 1_200),
      piece("c", "下一句", 1_200 + SENTENCE_GAP_MS, 1_800 + SENTENCE_GAP_MS),
    ]);
    expect(split.map((line) => line.text)).toEqual(["上一句没有标点", "下一句"]);
    expect(split.map((line) => line.closed)).toEqual([true, false]);
  });

  it("长于阈值的间隔不会并成一句", () => {
    const lines = aggregateSentences([
      piece("a", "前半", 0, 600),
      piece("b", "后半", 600 + SENTENCE_GAP_MS + 700, 1_900 + SENTENCE_GAP_MS),
    ]);
    expect(lines.map((line) => line.text)).toEqual(["前半", "后半"]);
    expect(lines[0]?.closed).toBe(true);
    expect(lines[1]?.closed).toBe(false);
    expect(lines[0]?.endMs).toBe(600);
    expect(lines[1]?.startMs).toBe(600 + SENTENCE_GAP_MS + 700);
  });

  it("单个英文句点不收束，中文直接相连，英文词之间补空格", () => {
    const decimal = aggregateSentences([
      piece("a", "价格 3.", 0, 600),
      piece("b", "14 元", 600, 1_200),
    ]);
    expect(decimal).toHaveLength(1);
    expect(decimal[0]?.text).toBe("价格 3.14 元");

    const english = aggregateSentences([
      piece("a", "hello", 0, 600),
      piece("b", "world", 600, 1_200),
    ]);
    expect(english[0]?.text).toBe("hello world");
  });

  it("空文本丢掉，不占行，也不挡住近邻拼接", () => {
    const input = [
      piece("b", "世界", 1_200, 1_800),
      piece("empty", "   ", 600, 1_200),
      piece("blank", "", 1_800, 2_400),
      piece("a", "你好", 0, 600),
    ];
    const lines = aggregateSentences(input);
    expect(lines.map((line) => line.text)).toEqual(["你好世界"]);
    expect(lines[0]?.sources.map((item) => item.id)).toEqual(["a", "b"]);
    expect(input.map((item) => item.id)).toEqual(["b", "empty", "blank", "a"]);
    expect(aggregateSentences([piece("x", "", 0, 600), piece("y", "  ", 600, 1_200)])).toEqual([]);
  });

  it("未收束的句子是一行生长字幕，已有标点的 final 不吞掉下一条 partial", () => {
    const growing = presentCaptions(
      [piece("a", "今天", 0, 600), piece("b", "天气", 600, 1_200)],
      null,
    );
    expect(growing).toEqual([
      expect.objectContaining({ id: "sentence:a", text: "今天天气", closed: false, growing: true }),
    ]);

    const settled = presentCaptions(
      [piece("a", "大家好。", 0, 1_800, "fake-0")],
      piece("p", "这款", 2_200, 2_600, "fake-1"),
    );
    expect(settled.map((line) => ({ id: line.id, text: line.text, growing: line.growing }))).toEqual([
      { id: "sentence:fake-0", text: "大家好。", growing: false },
      { id: "sentence:fake-1", text: "这款", growing: true },
    ]);

    const joined = presentCaptions(
      [piece("a", "今天", 0, 600)],
      piece("p", "天气", 600, 900),
    );
    expect(joined).toHaveLength(1);
    expect(joined[0]?.text).toBe("今天天气");
    expect(joined[0]?.growing).toBe(true);
  });

  it("软切默认约 48 个码点、6 秒", () => {
    expect(SENTENCE_MAX_CHARS).toBe(48);
    expect(SENTENCE_MAX_DURATION_MS).toBe(6_000);
  });

  it("无标点且间隔远小于 800ms 时，累计到 48 个码点就另起一行", () => {
    const pieces = Array.from({ length: 12 }, (_, index) =>
      piece(`p${index}`, chars(6, index * 6), index * 200, index * 200 + 180),
    );
    const lines = aggregateSentences(pieces);
    expect(lines.map((line) => line.text)).toEqual([
      pieces.slice(0, 8).map((item) => item.text).join(""),
      pieces.slice(8).map((item) => item.text).join(""),
    ]);
    expect(Array.from(lines[0]?.text ?? "")).toHaveLength(48);
    expect(lines.map((line) => line.closed)).toEqual([true, false]);
    expect(lines[0]?.sources.map((item) => item.id)).toEqual(pieces.slice(0, 8).map((item) => item.id));
    expect(lines[0]?.endMs).toBe(pieces[7]?.endMs);
    expect(lines[1]?.startMs).toBe(pieces[8]?.startMs);
    expect(lines[0]!.endMs - lines[0]!.startMs).toBeLessThan(SENTENCE_MAX_DURATION_MS);
  });

  it("无标点密讲的时间跨度达到 6000ms 就另起一行", () => {
    const pieces = Array.from({ length: 12 }, (_, index) =>
      piece(`p${index}`, "啊", index * 600, (index + 1) * 600),
    );
    const lines = aggregateSentences(pieces);
    expect(lines.map((line) => line.text)).toEqual(["啊".repeat(10), "啊啊"]);
    expect(lines[0]?.closed).toBe(true);
    expect(lines[0]!.endMs - lines[0]!.startMs).toBe(SENTENCE_MAX_DURATION_MS);
    expect(lines[1]?.closed).toBe(false);
    expect(lines[1]?.startMs).toBe(6_000);
    expect(Array.from(lines[0]?.text ?? "").length).toBeLessThan(SENTENCE_MAX_CHARS);
  });

  it("字数按 Unicode 码点计，单个超长 final 不从中间拆开", () => {
    const rare = "𠀀".repeat(SENTENCE_MAX_CHARS);
    expect(rare.length).toBe(SENTENCE_MAX_CHARS * 2);
    const lines = aggregateSentences([
      piece("a", rare, 0, 300),
      piece("b", "下一字", 300, 600),
    ]);
    expect(lines.map((line) => line.text)).toEqual([rare, "下一字"]);
    expect(lines[0]?.closed).toBe(true);
    expect(lines[0]?.sources).toHaveLength(1);

    const under = aggregateSentences([piece("a", chars(SENTENCE_MAX_CHARS - 1), 0, 100)]);
    const exact = aggregateSentences([piece("a", chars(SENTENCE_MAX_CHARS), 0, 100)]);
    expect(under[0]?.closed).toBe(false);
    expect(exact[0]?.closed).toBe(true);
    const shortSpan = aggregateSentences([piece("a", "短", 0, SENTENCE_MAX_DURATION_MS - 1)]);
    const fullSpan = aggregateSentences([piece("a", "短", 0, SENTENCE_MAX_DURATION_MS)]);
    expect(shortSpan[0]?.closed).toBe(false);
    expect(fullSpan[0]?.closed).toBe(true);
  });

  it("接近字数上限且以逗号或顿号结尾时提前换行，离得远或英文逗号则不切", () => {
    const comma = chars(39) + "，";
    const enumeration = chars(39) + "、";
    for (const head of [comma, enumeration]) {
      const lines = aggregateSentences([
        piece("a", head, 0, 400),
        piece("b", "后面继续", 400, 800),
      ]);
      expect(lines.map((line) => line.text)).toEqual([head, "后面继续"]);
      expect(lines[0]?.closed).toBe(true);
      expect(lines[1]?.closed).toBe(false);
    }

    const early = aggregateSentences([
      piece("a", "先说，", 0, 300),
      piece("b", "再接一句", 300, 600),
    ]);
    expect(early).toHaveLength(1);
    expect(early[0]?.text).toBe("先说，再接一句");

    const ascii = chars(39) + ",";
    const kept = aggregateSentences([
      piece("a", ascii, 0, 100),
      piece("b", "后续", 100, 200),
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.text).toBe(`${ascii}后续`);
  });

  it("未到软切上限时仍拼成一句，标点和静音继续优先切开", () => {
    const dense = aggregateSentences([
      piece("a", "还在说", 0, 200),
      piece("b", "没有标点", 220, 400),
      piece("empty", "  ", 400, 500),
      piece("c", "仍是一句", 500, 700),
    ]);
    expect(dense.map((line) => line.text)).toEqual(["还在说没有标点仍是一句"]);
    expect(dense[0]?.closed).toBe(false);
    expect(dense[0]?.sources.map((item) => item.id)).toEqual(["a", "b", "c"]);

    const punct = aggregateSentences([
      piece("a", "先停一下。", 0, 400),
      piece("b", "下一句", 400, 800),
    ]);
    expect(punct.map((line) => line.text)).toEqual(["先停一下。", "下一句"]);

    const gap = aggregateSentences([
      piece("a", "上一句", 0, 400),
      piece("b", "下一句", 400 + SENTENCE_GAP_MS, 800 + SENTENCE_GAP_MS),
    ]);
    expect(gap.map((line) => line.text)).toEqual(["上一句", "下一句"]);
    expect(gap[0]?.closed).toBe(true);
  });

  it("可以收紧或关掉软切", () => {
    const pieces = Array.from({ length: 4 }, (_, index) =>
      piece(`p${index}`, chars(6, index * 6), index * 200, index * 200 + 180),
    );
    expect(aggregateSentences(pieces)).toHaveLength(1);
    expect(aggregateSentences(pieces, { maxChars: 12 }).map((line) => Array.from(line.text).length)).toEqual([12, 12]);

    const timed = Array.from({ length: 4 }, (_, index) =>
      piece(`d${index}`, "啊", index * 600, (index + 1) * 600),
    );
    expect(aggregateSentences(timed, { maxDurationMs: 1_200 }).map((line) => line.text)).toEqual(["啊啊", "啊啊"]);
    expect(
      aggregateSentences(timed, { maxChars: Number.POSITIVE_INFINITY, maxDurationMs: Number.POSITIVE_INFINITY }),
    ).toHaveLength(1);
  });

  it("直播字幕和 JSONL 回看都经 presentCaptions 吃到软切", () => {
    const finals = Array.from({ length: 12 }, (_, index) =>
      piece(`p${index}`, chars(6, index * 6), index * 200, index * 200 + 180),
    );
    const replay = presentCaptions(finals, null);
    expect(replay.length).toBeGreaterThan(1);
    expect(replay[0]?.growing).toBe(false);
    expect(replay.at(-1)?.growing).toBe(true);
    expect(replay[0]?.closed).toBe(true);

    const afterFullLine = presentCaptions(
      [piece("a", chars(SENTENCE_MAX_CHARS), 0, 600)],
      piece("p", "还在说", 600, 900),
    );
    expect(afterFullLine.map((line) => line.text)).toEqual([chars(SENTENCE_MAX_CHARS), "还在说"]);
    expect(afterFullLine.map((line) => line.growing)).toEqual([false, true]);

    const pushedOver = presentCaptions(
      [piece("a", chars(40), 0, 600)],
      piece("p", chars(10), 600, 900),
    );
    expect(pushedOver).toHaveLength(1);
    expect(Array.from(pushedOver[0]?.text ?? "")).toHaveLength(50);
    expect(pushedOver[0]?.closed).toBe(true);
    expect(pushedOver[0]?.growing).toBe(false);

    const timed = presentCaptions(
      [piece("a", "还在说", 0, 6_000)],
      piece("p", "下一小段", 6_000, 6_400),
    );
    expect(timed.map((line) => line.text)).toEqual(["还在说", "下一小段"]);
    expect(timed[0]?.closed).toBe(true);
    expect(timed[1]?.growing).toBe(true);
  });

  it("讯飞式 final 行首的句号或逗号挂回上一行，不丢字、也不改原文", () => {
    const midPhrase = presentCaptions(
      [
        piece("a", "两套不够", 0, 800),
        piece("b", "。那个那个节过来", 800, 1_600),
        piece("c", "，对再加一套", 1_600, 2_400),
      ],
      null,
    );
    expect(midPhrase.map((line) => line.text)).toEqual(["两套不够。", "那个那个节过来，对再加一套"]);
    expect(midPhrase.map((line) => line.closed)).toEqual([true, false]);
    expect(midPhrase[0]?.growing).toBe(false);
    expect(midPhrase[1]?.growing).toBe(true);
    expect(midPhrase.every((line) => !startsWithOrphanPunct(line.text))).toBe(true);

    const head = chars(SENTENCE_MAX_CHARS);
    const wrapped = presentCaptions(
      [
        piece("a", head, 0, 2_000),
        piece("b", `，${chars(SENTENCE_MAX_CHARS)}`, 2_000, 4_000),
        piece("c", "。那个那个", 4_000, 5_000),
      ],
      null,
    );
    expect(wrapped.map((line) => line.text)).toEqual([`${head}，`, `${chars(SENTENCE_MAX_CHARS)}。`, "那个那个"]);
    expect(wrapped.map((line) => line.closed)).toEqual([true, true, false]);
    expect(wrapped.every((line) => !startsWithOrphanPunct(line.text))).toBe(true);
    expect(wrapped).toHaveLength(3);

    const timed = presentCaptions(
      [
        piece("a", "送点然后就不够", 0, SENTENCE_MAX_DURATION_MS),
        piece("b", "，两套不够", SENTENCE_MAX_DURATION_MS, SENTENCE_MAX_DURATION_MS + 800),
      ],
      null,
    );
    expect(timed.map((line) => line.text)).toEqual(["送点然后就不够，", "两套不够"]);
    expect(timed[0]?.closed).toBe(true);
    expect(timed[1]?.growing).toBe(true);

    const raw = [piece("a", "两套不够", 0, 800), piece("b", "。那个那个", 800, 1_400)];
    const rawPartial = piece("p", "，还在说", 1_400, 1_800);
    presentCaptions(raw, rawPartial);
    expect(raw.map((item) => item.text)).toEqual(["两套不够", "。那个那个"]);
    expect(rawPartial.text).toBe("，还在说");

    const earlyComma = presentCaptions(
      [piece("a", "先说", 0, 300), piece("b", "，再接一句", 300, 600)],
      null,
    );
    expect(earlyComma.map((line) => line.text)).toEqual(["先说，再接一句"]);
    expect(earlyComma).toHaveLength(1);

    const duplicate = presentCaptions(
      [piece("a", "已经说完。", 0, 600), piece("b", "。下一句", 600, 1_200)],
      null,
    );
    expect(duplicate.map((line) => line.text)).toEqual(["已经说完。", "下一句"]);

    const orphanComma = presentCaptions(
      [piece("a", "已经说完。", 0, 600), piece("b", "，下一句", 600, 1_200)],
      null,
    );
    expect(orphanComma.map((line) => line.text)).toEqual(["已经说完。", "下一句"]);

    const rulesStayRaw = [
      piece("a", "两套不够", 0, 800),
      piece("b", "。那个那个", 800, 1_600),
    ];
    expect(aggregateSentences(rulesStayRaw).map((line) => line.text)).toEqual(["两套不够。那个那个"]);
    expect(presentCaptions(rulesStayRaw, null).map((line) => line.text)).toEqual(["两套不够。", "那个那个"]);

    const partialPeriod = presentCaptions(
      [piece("a", "两套不够", 0, 800)],
      piece("p", "。那个那个", 800, 1_200),
    );
    expect(partialPeriod.map((line) => ({ text: line.text, growing: line.growing }))).toEqual([
      { text: "两套不够。", growing: false },
      { text: "那个那个", growing: true },
    ]);

    const decimal = presentCaptions(
      [piece("a", "到手价3", 0, 400), piece("b", ".14元", 400, 800)],
      null,
    );
    expect(decimal.map((line) => line.text)).toEqual(["到手价3.14元"]);

    const onlyPunct = presentCaptions(
      [piece("a", "两套不够", 0, 600), piece("b", "。", 600, 700), piece("c", "那个那个", 700, 1_200)],
      null,
    );
    expect(onlyPunct.map((line) => line.text)).toEqual(["两套不够。", "那个那个"]);

    const ellipsis = presentCaptions(
      [piece("a", "说到这", 0, 400), piece("b", "...下一句", 400, 800)],
      null,
    );
    expect(ellipsis.map((line) => line.text)).toEqual(["说到这...", "下一句"]);

    const asciiComma = presentCaptions(
      [piece("a", chars(SENTENCE_MAX_CHARS), 0, 1_000), piece("b", ",两套不够", 1_000, 1_600)],
      null,
    );
    expect(asciiComma.map((line) => line.text)).toEqual([`${chars(SENTENCE_MAX_CHARS)},`, "两套不够"]);

    const spacedComma = presentCaptions(
      [piece("a", chars(SENTENCE_MAX_CHARS), 0, 1_000), piece("b", "， 两套不够", 1_000, 1_600)],
      null,
    );
    expect(spacedComma.map((line) => line.text)).toEqual([`${chars(SENTENCE_MAX_CHARS)}，`, "两套不够"]);
    expect(spacedComma.every((line) => !startsWithOrphanPunct(line.text))).toBe(true);
  });
});

function startsWithOrphanPunct(text: string): boolean {
  return /^(?:\.{3}|[，、,。！？!?；;…])/u.test(text.trimStart());
}
