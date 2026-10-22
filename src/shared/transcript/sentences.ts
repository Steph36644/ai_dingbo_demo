/**
 * 第 1 档成句：展示时把连续短 final 拼成一句。规则引擎的跨段关键词另走标点 / 静音，不吃软切。
 *
 * FunASR 流式每约 600ms 给一段新文本，sidecar 仍把非空块标成 isFinal。
 * 这里不改适配器协议，也不改模型，也不改落盘片段。句界如下，都可调：
 *
 * 1. 句末标点 `SENTENCE_ENDING_CHARS`，另加英文省略号 `...`。
 *    单个英文句点 `.` 不算，避免小数被切断。
 * 2. 相邻片段的间隔 ≥ `SENTENCE_GAP_MS`（800ms，落在 0.6–1.0s）。
 *    600ms 正好是一个 FunASR 空块，仍视为同一句，免得一顿呼吸就拆行；
 *    间隔要到 800ms 才收束。收束发生在「下一段到来」时，因为展示层只有片段时间戳。
 * 3. 软切，只为密讲字幕换行：无标点、间隔也到不了 800ms 时，累计 Unicode 码点达到
 *    `SENTENCE_MAX_CHARS`（48），或本句 `endMs - startMs` 达到 `SENTENCE_MAX_DURATION_MS`
 *    （6000ms），就收束当前行。不拆开单个 final。已经接近字数上限、且该段以 `，` / `、`
 *    结尾时，提前在这个标点后换行。Monitor 与 JSONL 回看都走 `presentCaptions`。
 *
 * 讯飞 RTASR 的句读经常落在下一条 final / partial 的开头。展示时把行首的
 * `。！？!?；;…`、英文省略号 `...`，以及 `，` / `、` / 英文逗号挂回上一句。
 * 上一句已经以句末标点收束时，这些多余的行首标点丢掉，避免叠成 `。。`。
 * 没有上一句时保留原文（FunASR 标点块首的句读仍留给合并逻辑，不在这里剥掉）。
 * 单个英文句点不算行首标点。不改原始片段；规则引擎走 `aggregateSentences`，仍按原文拼接。
 *
 * 尚未收束的最后一句保持 open，字幕用 partial 样式画成一行正在生长的字。
 */

export const SENTENCE_ENDING_CHARS = "。！？!?；;…";

/** 段间静音达到该毫秒数就另起一句。见文件头说明。 */
export const SENTENCE_GAP_MS = 800;

/** 一句累计 Unicode 码点达到该字数就软切。一个汉字算 1，不用 UTF-16 码元。 */
export const SENTENCE_MAX_CHARS = 48;

/** 开放句的 endMs - startMs 达到该毫秒数就软切。 */
export const SENTENCE_MAX_DURATION_MS = 6_000;

/** 距字数上限不足这么多个码点，且原文以逗号或顿号结尾，就提前收束。 */
const SOFT_BREAK_LOOKBACK = 8;

const SENTENCE_ENDING_RE = new RegExp(`(?:[${SENTENCE_ENDING_CHARS}]|\\.{3})$`, "u");
const LATIN_OR_DIGIT = /[A-Za-z0-9]/;
const SOFT_BREAK_CHARS = new Set(["，", "、"]);
/** 可以单独出现在下一条片段开头、但应该挂回上一句的句读。不含单个 `.`。 */
const LEADING_PUNCT_CHARS = new Set(Array.from(`${SENTENCE_ENDING_CHARS}，、,`));

export type SentencePiece = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  /** 同一句识别结果的稳定 id。partial 落成 final 时用来保持字幕行 key。 */
  sourceResultId?: string;
};

export type SentenceAggregateOptions = {
  gapMs?: number;
  /** 累计码点达到该值就收束。`Infinity` 表示不按字数软切。 */
  maxChars?: number;
  /** 开放句 endMs - startMs 达到该毫秒数就收束。`Infinity` 表示不按时长软切。 */
  maxDurationMs?: number;
};

export type AggregatedSentence<T extends SentencePiece = SentencePiece> = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  /** 已遇句末标点、被静音切开，或被字数 / 时长软切。最后一句在这些条件出现前为 false。 */
  closed: boolean;
  sources: T[];
};

export type CaptionLine = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  closed: boolean;
  /** 句还没收束，字幕画成一行带光标的生长句。 */
  growing: boolean;
};

type ResolvedSentenceOptions = {
  gapMs: number;
  maxChars: number;
  maxDurationMs: number;
};

export function endsWithSentencePunctuation(text: string): boolean {
  return SENTENCE_ENDING_RE.test(text.trimEnd());
}

/** 中文直接拼接；两侧都是英文或数字时补一个空格。 */
export function joinSentenceText(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  const leftChar = Array.from(left.trimEnd()).at(-1) ?? "";
  const rightChar = Array.from(right.trimStart())[0] ?? "";
  if (LATIN_OR_DIGIT.test(leftChar) && LATIN_OR_DIGIT.test(rightChar) && !/\s$/.test(left) && !/^\s/.test(right)) {
    return `${left} ${right}`;
  }
  if (/\s$/.test(left) && /^\s/.test(right)) return left + right.trimStart();
  return left + right;
}

function resolveSentenceOptions(options?: SentenceAggregateOptions): ResolvedSentenceOptions {
  return {
    gapMs: options?.gapMs ?? SENTENCE_GAP_MS,
    maxChars: options?.maxChars ?? SENTENCE_MAX_CHARS,
    maxDurationMs: options?.maxDurationMs ?? SENTENCE_MAX_DURATION_MS,
  };
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** 接近字数上限时，逗号 / 顿号比硬切更适合做行尾。 */
function nearSoftBreak(text: string, maxChars: number): boolean {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return false;
  const chars = Array.from(text.trimEnd());
  const last = chars.at(-1) ?? "";
  if (!SOFT_BREAK_CHARS.has(last)) return false;
  const earliest = Math.max(1, maxChars - SOFT_BREAK_LOOKBACK);
  return chars.length >= earliest && chars.length < maxChars;
}

function sentenceClosed(text: string, startMs: number, endMs: number, options: ResolvedSentenceOptions): boolean {
  if (endsWithSentencePunctuation(text)) return true;
  if (Number.isFinite(options.maxChars) && codePointLength(text) >= options.maxChars) return true;
  if (Number.isFinite(options.maxDurationMs) && endMs - startMs >= options.maxDurationMs) return true;
  return nearSoftBreak(text, options.maxChars);
}

function sentenceKey(piece: SentencePiece): string {
  return `sentence:${piece.sourceResultId ?? piece.id}`;
}

function comparePieces(a: SentencePiece, b: SentencePiece): number {
  return a.startMs - b.startMs || a.endMs - b.endMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function hasText(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * 把按时间排列的短片段收成句。空文本丢掉，不参与拼接，也不单独占一行。
 * 不修改入参。软切默认打开；传入 `Infinity` 可只保留标点与静音。
 */
export function aggregateSentences<T extends SentencePiece>(
  pieces: readonly T[],
  options?: SentenceAggregateOptions,
): AggregatedSentence<T>[] {
  const resolved = resolveSentenceOptions(options);
  const ordered = pieces.filter((piece) => hasText(piece.text)).sort(comparePieces);
  const groups: AggregatedSentence<T>[] = [];

  for (const piece of ordered) {
    const last = groups[groups.length - 1];
    const gap = last ? piece.startMs - last.endMs : 0;
    const startNew = !last || last.closed || gap >= resolved.gapMs;
    if (!last || startNew) {
      if (last && !last.closed) last.closed = true;
      groups.push({
        id: sentenceKey(piece),
        startMs: piece.startMs,
        endMs: piece.endMs,
        text: piece.text,
        closed: sentenceClosed(piece.text, piece.startMs, piece.endMs, resolved),
        sources: [piece],
      });
      continue;
    }
    last.text = joinSentenceText(last.text, piece.text);
    last.endMs = Math.max(last.endMs, piece.endMs);
    last.startMs = Math.min(last.startMs, piece.startMs);
    last.closed = sentenceClosed(last.text, last.startMs, last.endMs, resolved);
    last.sources.push(piece);
  }

  return groups;
}

/**
 * 字幕行。final 先成句；仍开放的最后一句可以接上 partial。
 * 已有句末标点、或已被软切收束的 final，不会吞掉下一条 partial。
 * 直播 Monitor 与 JSONL 回看都走这里，因此软切两处一起生效。
 * 下一条以句读开头时，标点挂回上一行，字幕行不再以 `，` / `。` 起行。
 */
export function presentCaptions(
  finals: readonly SentencePiece[],
  partial: SentencePiece | null,
  options?: SentenceAggregateOptions,
): CaptionLine[] {
  const resolved = resolveSentenceOptions(options);
  const displayFinals = rebaseLeadingPunctuation(finals);
  const displayPartial = rebasePartialPunctuation(displayFinals, partial);
  const lines: CaptionLine[] = aggregateSentences(displayFinals, resolved).map((sentence) => ({
    id: sentence.id,
    startMs: sentence.startMs,
    endMs: sentence.endMs,
    text: sentence.text,
    closed: sentence.closed,
    growing: false,
  }));

  if (displayPartial && hasText(displayPartial.text)) {
    const last = lines[lines.length - 1];
    const gap = last ? displayPartial.startMs - last.endMs : Number.POSITIVE_INFINITY;
    if (last && !last.closed && gap >= 0 && gap < resolved.gapMs) {
      last.text = joinSentenceText(last.text, displayPartial.text);
      last.endMs = Math.max(last.endMs, displayPartial.endMs);
      last.startMs = Math.min(last.startMs, displayPartial.startMs);
      last.closed = sentenceClosed(last.text, last.startMs, last.endMs, resolved);
    } else {
      lines.push({
        id: sentenceKey(displayPartial),
        startMs: displayPartial.startMs,
        endMs: displayPartial.endMs,
        text: displayPartial.text,
        closed: sentenceClosed(displayPartial.text, displayPartial.startMs, displayPartial.endMs, resolved),
        growing: false,
      });
    }
  }

  const last = lines[lines.length - 1];
  if (last && !last.closed) last.growing = true;
  return lines;
}

/**
 * 行首句读挂回时间上的上一句。复制入参，不改调用方持有的片段。
 * 没有上一句时原样留下，避免剥掉 FunASR 整段标点文本开头的句号。
 */
function rebaseLeadingPunctuation<T extends SentencePiece>(pieces: readonly T[]): T[] {
  const sorted = pieces.filter((piece) => hasText(piece.text)).map((piece) => ({ ...piece })).sort(comparePieces);
  const kept: T[] = [];
  for (const piece of sorted) {
    const { punct, rest } = takeLeadingPunctuation(piece.text);
    if (!punct) {
      kept.push(piece);
      continue;
    }
    const previous = kept[kept.length - 1];
    if (!previous) {
      kept.push(piece);
      continue;
    }
    if (!endsWithSentencePunctuation(previous.text)) previous.text = joinSentenceText(previous.text, punct);
    if (!hasText(rest)) continue;
    kept.push({ ...piece, text: rest });
  }
  return kept;
}

function rebasePartialPunctuation<T extends SentencePiece>(
  finals: readonly T[],
  partial: SentencePiece | null,
): SentencePiece | null {
  if (!partial || !hasText(partial.text)) return null;
  const { punct, rest } = takeLeadingPunctuation(partial.text);
  if (!punct) return partial;
  const previous = finals[finals.length - 1];
  if (!previous) return partial;
  if (!endsWithSentencePunctuation(previous.text)) previous.text = joinSentenceText(previous.text, punct);
  if (!hasText(rest)) return null;
  return { ...partial, text: rest };
}

/** 取开头的句读。单个英文句点留下，英文省略号 `...` 整段取走。 */
function takeLeadingPunctuation(text: string): { punct: string; rest: string } {
  let rest = text.trimStart();
  let punct = "";
  if (rest.startsWith("...")) {
    punct = "...";
    rest = rest.slice(3).trimStart();
  }
  const chars = Array.from(rest);
  let index = 0;
  while (index < chars.length && LEADING_PUNCT_CHARS.has(chars[index] ?? "")) index += 1;
  if (index > 0) {
    punct += chars.slice(0, index).join("");
    rest = chars.slice(index).join("").trimStart();
  }
  if (!punct) return { punct: "", rest: text };
  return { punct, rest };
}
