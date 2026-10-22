/**
 * 把标点后的文本铺回展示片段，再交给 `presentCaptions`。
 *
 * 这是成句之前的一步，不改 `sentences.ts` 的标点、静音和软切规则。
 * 句末标点收成独立片段，让 `presentCaptions` 在这里断句。
 * 没有句末标点的跨度仍按原始 final 切开，字数和时长软切才能继续生效。
 * 对不齐（模型改了字，不只是插入标点）时退回原文，字幕保持现在的行为。
 */

import type { PunctuationOverlay } from "@shared/contracts/transcript";
import {
  SENTENCE_GAP_MS,
  endsWithSentencePunctuation,
  joinSentenceText,
  presentCaptions,
  type CaptionLine,
  type SentenceAggregateOptions,
  type SentencePiece,
} from "./sentences";

/** 允许标点模型插入、但不许替换原文的符号。已有的小数点会与原文对齐，不算插入。 */
const INSERTABLE = new Set(
  Array.from("。！？!?；;…，、,：:．.\"“”‘’「」『』（）()【】[]—～·、"),
);

type Anchor = {
  pieceIndex: number;
  /** 片段内的码点下标。拼接出来的空格为 -1。 */
  offset: number;
};

export function joinPieces(pieces: readonly { text: string }[]): string {
  return pieces.reduce((text, piece) => joinSentenceText(text, piece.text), "");
}

/**
 * 后一次返回若已经包含此前的全文，视为整段重写；否则接在后面。
 * 下一块开头的标点留着，不 strip。
 */
export function mergePunctuationChunk(previous: string, next: string): string {
  if (!previous) return next;
  if (next.startsWith(previous)) return next;
  return previous + next;
}

export function textsAlign(raw: string, punctuated: string): boolean {
  const rawChars = Array.from(raw);
  const punctChars = Array.from(punctuated);
  let index = 0;
  for (const punctChar of punctChars) {
    if (rawChars[index] === punctChar) {
      index += 1;
      continue;
    }
    if (INSERTABLE.has(punctChar)) continue;
    return false;
  }
  return index === rawChars.length;
}

export function applyPunctuationOverlay<T extends SentencePiece>(
  finals: readonly T[],
  overlay: PunctuationOverlay | null,
  options?: SentenceAggregateOptions,
): T[] | SentencePiece[] {
  if (!overlay || overlay.sourceIds.length === 0 || overlay.text.length === 0) return finals.slice();
  const start = finals.findIndex((piece) => piece.id === overlay.sourceIds[0]);
  if (start < 0) return finals.slice();
  const covered: T[] = [];
  for (let index = 0; index < overlay.sourceIds.length; index += 1) {
    const piece = finals[start + index];
    if (!piece || piece.id !== overlay.sourceIds[index]) return finals.slice();
    covered.push(piece);
  }
  const split = splitPunctuatedPieces(covered, overlay.text, options);
  if (!split) return finals.slice();
  return [...finals.slice(0, start), ...split, ...finals.slice(start + covered.length)];
}

/**
 * 字幕行。无覆盖、覆盖对不齐或模型不可用时，与 `presentCaptions(finals, partial)` 相同。
 */
export function presentPunctuatedCaptions(
  finals: readonly SentencePiece[],
  partial: SentencePiece | null,
  overlay: PunctuationOverlay | null,
  options?: SentenceAggregateOptions,
): CaptionLine[] {
  return presentCaptions(applyPunctuationOverlay(finals, overlay, options), partial, options);
}

export function splitPunctuatedPieces(
  sources: readonly SentencePiece[],
  punctuated: string,
  options?: SentenceAggregateOptions,
): SentencePiece[] | null {
  if (sources.length === 0) return null;
  const flat = flattenJoined(sources);
  if (punctuated === flat.text) return sources.map((piece) => ({ ...piece }));
  if (!textsAlign(flat.text, punctuated)) return null;

  const gapMs = options?.gapMs ?? SENTENCE_GAP_MS;
  const rawChars = Array.from(flat.text);
  const pieces: SentencePiece[] = [];
  let buffer = "";
  let startAnchor: Anchor | null = null;
  let endAnchor: Anchor | null = null;
  let rawIndex = 0;

  const close = () => {
    if (!buffer || !startAnchor || !endAnchor) {
      buffer = "";
      startAnchor = null;
      endAnchor = null;
      return;
    }
    pieces.push(displayPiece(sources, buffer, startAnchor, endAnchor, pieces.length));
    buffer = "";
    startAnchor = null;
    endAnchor = null;
  };

  for (const punctChar of Array.from(punctuated)) {
    if (rawChars[rawIndex] === punctChar) {
      const anchor = flat.anchors[rawIndex];
      if (!anchor) return null;
      if (endAnchor && anchorGap(sources, endAnchor, anchor) >= gapMs) close();
      // 换到下一条 final 就收束当前片段。逗号留在上一段末尾，软切仍按条累计。
      if (endAnchor && anchor.pieceIndex !== endAnchor.pieceIndex && anchor.offset >= 0) close();
      if (!startAnchor) startAnchor = anchor;
      endAnchor = anchor;
      buffer += punctChar;
      rawIndex += 1;
    } else if (INSERTABLE.has(punctChar)) {
      buffer += punctChar;
    } else {
      return null;
    }
    if (startAnchor && endsWithSentencePunctuation(buffer)) close();
  }

  if (rawIndex !== rawChars.length) return null;
  if (buffer) {
    if (!startAnchor || !endAnchor) {
      if (pieces.length === 0) return null;
      const last = pieces[pieces.length - 1];
      if (!last) return null;
      last.text += buffer;
    } else {
      pieces.push(displayPiece(sources, buffer, startAnchor, endAnchor, pieces.length));
    }
  }
  return pieces.length > 0 ? pieces : null;
}

function displayPiece(
  sources: readonly SentencePiece[],
  text: string,
  start: Anchor,
  end: Anchor,
  ordinal: number,
): SentencePiece {
  const startPiece = sources[start.pieceIndex];
  const id = `punc:${startPiece?.id ?? "x"}:${start.offset}:${ordinal}`;
  return {
    id,
    sourceResultId: id,
    text,
    startMs: anchorTime(sources, start, false),
    endMs: anchorTime(sources, end, true),
  };
}

function anchorGap(sources: readonly SentencePiece[], previous: Anchor, next: Anchor): number {
  if (previous.pieceIndex === next.pieceIndex) return 0;
  const left = sources[previous.pieceIndex];
  const right = sources[next.pieceIndex];
  if (!left || !right) return 0;
  return right.startMs - left.endMs;
}

function anchorTime(sources: readonly SentencePiece[], anchor: Anchor, atEnd: boolean): number {
  const piece = sources[anchor.pieceIndex];
  if (!piece) return 0;
  if (anchor.offset < 0) return atEnd ? piece.endMs : piece.startMs;
  const count = Math.max(Array.from(piece.text).length, 1);
  const span = piece.endMs - piece.startMs;
  const index = atEnd ? anchor.offset + 1 : anchor.offset;
  return piece.startMs + Math.round((span * index) / count);
}

function flattenJoined(sources: readonly SentencePiece[]): { text: string; anchors: Anchor[] } {
  let text = "";
  const anchors: Anchor[] = [];
  sources.forEach((piece, pieceIndex) => {
    const next = joinSentenceText(text, piece.text);
    const added = Array.from(next.slice(text.length));
    const pieceChars = Array.from(piece.text);
    let pieceIndexInChars = 0;
    for (const char of added) {
      if (pieceChars[pieceIndexInChars] === char) {
        anchors.push({ pieceIndex, offset: pieceIndexInChars });
        pieceIndexInChars += 1;
      } else {
        anchors.push({ pieceIndex: Math.max(0, pieceIndex - 1), offset: -1 });
      }
    }
    text = next;
  });
  return { text, anchors };
}
