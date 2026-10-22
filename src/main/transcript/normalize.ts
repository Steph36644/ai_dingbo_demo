import { FILLER_CHARS } from "@shared/config/defaults";

const FILLERS = new Set(Array.from(FILLER_CHARS));
const PUNCTUATION = /[，。！？、；：“”‘’（）【】「」『』…—·,.!?;:'"`~\-()[\]{}]/u;

export function toHalfWidth(input: string): string {
  let out = "";
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x3000) out += " ";
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCodePoint(code - 0xfee0);
    else out += char;
  }
  return out;
}

export function isPunctuation(char: string): boolean {
  return PUNCTUATION.test(char);
}

/** 去首尾空白、全角转半角、英文小写、合并空白，并去掉常见 ASR 标点。原文另存。 */
export function normalizeText(input: string): string {
  const half = toHalfWidth(input).toLowerCase();
  let out = "";
  for (const char of half) {
    out += isPunctuation(char) ? " " : char;
  }
  return out.replace(/\s+/g, " ").trim();
}

function collapseStutter(chars: string[]): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < chars.length) {
    let end = index + 1;
    while (end < chars.length && chars[end] === chars[index]) end += 1;
    const run = end - index;
    if (run >= 3) out.push(chars[index] ?? "");
    else for (let i = index; i < end; i += 1) out.push(chars[i] ?? "");
    index = end;
  }
  return out;
}

/**
 * 有效字数：Unicode 码点。去掉标点和空白；整段只剩语气词计 0；
 * 连续 3 次及以上的同一字符视为口吃碎片，折叠成 1 个码点。
 */
export function countEffectiveChars(input: string): number {
  const normalized = normalizeText(input);
  const chars = Array.from(normalized).filter((char) => char !== " " && !isPunctuation(char));
  if (chars.length === 0) return 0;
  if (chars.every((char) => FILLERS.has(char))) return 0;
  return collapseStutter(chars).length;
}
