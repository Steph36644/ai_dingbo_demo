import { QUALITY_GATES } from "@shared/config/defaults";
import type { FrameworkItem } from "@shared/contracts/framework";
import type { TranscriptSegment } from "@shared/contracts/transcript";
import { aggregateSentences, joinSentenceText } from "@shared/transcript/sentences";
import { keywordsUsePriceLexicon, textHasPriceMention } from "../actions/cues";
import { countEffectiveChars, normalizeText } from "../transcript/normalize";
import { intervalDuration, intersectIntervals, mergeIntervals, subtractIntervals, type Interval } from "./intervals";

export type ItemHit = {
  keywords: string[];
  segments: TranscriptSegment[];
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 单字按非字母数字边界匹配；多字中文短语做子串匹配。两侧都先规范化。 */
export function keywordMatches(normalizedText: string, keyword: string): boolean {
  const needle = normalizeText(keyword);
  if (!needle || !normalizedText) return false;
  if (Array.from(needle).length === 1) {
    const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}(?:$|[^\\p{L}\\p{N}])`, "u");
    return pattern.test(normalizedText);
  }
  return normalizedText.includes(needle);
}

export function matchFrameworkItems(segments: readonly TranscriptSegment[], items: readonly FrameworkItem[]): Map<string, ItemHit> {
  const found = new Map<string, ItemHit>();
  for (const item of items) {
    const keywords = new Set<string>();
    const hits: TranscriptSegment[] = [];
    const priceLexicon = keywordsUsePriceLexicon(item.keywords);
    for (const segment of segments) {
      const matched = item.keywords.filter((keyword) => keywordMatches(segment.normalizedText, keyword));
      const price = priceLexicon && matched.length === 0 && textHasPriceMention(segment.normalizedText);
      if (matched.length === 0 && !price) continue;
      for (const keyword of matched) keywords.add(normalizeText(keyword));
      if (price) keywords.add("价格");
      hits.push(segment);
    }
    if (hits.length === 0) continue;
    hits.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    found.set(item.id, { keywords: [...keywords], segments: hits });
  }

  // 多字关键词被切在相邻短 final 上时，按标点和静音再拼一次。
  // 字幕软切（字数 / 时长）不参与这里，免得密讲被拆行后漏掉跨段关键词。
  // 单字仍只看原片段，避免「活动价」里的「价」因为拼接而改变边界。
  // 语速和节奏继续用快照里的原始时间片，不在这里改。
  for (const sentence of aggregateSentences(segments, {
    maxChars: Number.POSITIVE_INFINITY,
    maxDurationMs: Number.POSITIVE_INFINITY,
  })) {
    if (sentence.sources.length < 2) continue;
    const joined = normalizeText(sentence.text);
    for (const item of items) {
      const spanning = item.keywords.filter((keyword) => spansFragments(sentence.sources, joined, keyword));
      const priceLexicon = keywordsUsePriceLexicon(item.keywords);
      const priceSpan = priceLexicon && spanning.length === 0
        && !sentence.sources.some((source) => textHasPriceMention(source.normalizedText))
        && textHasPriceMention(joined);
      if (spanning.length === 0 && !priceSpan) continue;
      const current = found.get(item.id);
      const keywords = new Set(current?.keywords ?? []);
      for (const keyword of spanning) keywords.add(normalizeText(keyword));
      if (priceSpan) keywords.add("价格");
      const hits = [...(current?.segments ?? [])];
      const seen = new Set(hits.map((segment) => segment.id));
      const covers = [
        ...coverKeywords(sentence.sources, spanning),
        ...(priceSpan ? smallestPriceCover(sentence.sources) : []),
      ];
      for (const segment of covers) {
        if (seen.has(segment.id)) continue;
        seen.add(segment.id);
        hits.push(segment);
      }
      hits.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
      found.set(item.id, { keywords: [...keywords], segments: hits });
    }
  }

  for (const [id, hit] of found) {
    found.set(id, { keywords: hit.keywords, segments: hit.segments.slice(0, QUALITY_GATES.maxExcerpts) });
  }
  return found;
}

function spansFragments(sources: readonly TranscriptSegment[], joinedNormalized: string, keyword: string): boolean {
  const needle = normalizeText(keyword);
  if (Array.from(needle).length <= 1) return false;
  if (sources.some((source) => keywordMatches(source.normalizedText, keyword))) return false;
  return keywordMatches(joinedNormalized, keyword);
}

function coverKeywords(sources: readonly TranscriptSegment[], keywords: readonly string[]): TranscriptSegment[] {
  const picked: TranscriptSegment[] = [];
  const seen = new Set<string>();
  for (const keyword of keywords) {
    for (const segment of smallestCover(sources, keyword)) {
      if (seen.has(segment.id)) continue;
      seen.add(segment.id);
      picked.push(segment);
    }
  }
  return picked;
}

function smallestPriceCover(sources: readonly TranscriptSegment[]): readonly TranscriptSegment[] {
  for (let length = 2; length <= sources.length; length += 1) {
    for (let start = 0; start + length <= sources.length; start += 1) {
      const slice = sources.slice(start, start + length);
      const text = normalizeText(slice.reduce((joined, segment) => joinSentenceText(joined, segment.text), ""));
      if (textHasPriceMention(text)) return slice;
    }
  }
  return sources;
}

function smallestCover(sources: readonly TranscriptSegment[], keyword: string): readonly TranscriptSegment[] {
  for (let length = 2; length <= sources.length; length += 1) {
    for (let start = 0; start + length <= sources.length; start += 1) {
      const slice = sources.slice(start, start + length);
      const text = normalizeText(slice.reduce((joined, segment) => joinSentenceText(joined, segment.text), ""));
      if (keywordMatches(text, keyword)) return slice;
    }
  }
  return sources;
}

export function dedupedEffectiveChars(segments: readonly TranscriptSegment[]): number {
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  let coveredUntil = Number.NEGATIVE_INFINITY;
  let total = 0;
  for (const segment of sorted) {
    if (segment.endMs <= coveredUntil) continue;
    const fromMs = Math.max(segment.startMs, coveredUntil);
    total += charsBetween(segment, fromMs, segment.endMs);
    coveredUntil = Math.max(coveredUntil, segment.endMs);
  }
  return total;
}

function charsBetween(segment: TranscriptSegment, fromMs: number, toMs: number): number {
  if (toMs <= fromMs) return 0;
  if (fromMs <= segment.startMs && toMs >= segment.endMs) return countEffectiveChars(segment.text);
  const chars = Array.from(segment.text);
  if (chars.length === 0) return 0;
  const duration = Math.max(1, segment.endMs - segment.startMs);
  const from = clamp(Math.floor(((fromMs - segment.startMs) / duration) * chars.length), 0, chars.length);
  const to = clamp(Math.ceil(((toMs - segment.startMs) / duration) * chars.length), from, chars.length);
  return countEffectiveChars(chars.slice(from, to).join(""));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function segmentIntervals(segments: readonly TranscriptSegment[]): Interval[] {
  return mergeIntervals(segments.map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs })));
}

export function audibleSpeech(speech: readonly Interval[], gaps: readonly Interval[]): Interval[] {
  return subtractIntervals(speech, gaps);
}

export function audibleSilence(silence: readonly Interval[], gaps: readonly Interval[]): Interval[] {
  return subtractIntervals(silence, gaps);
}

/** VAD 语音和 final 文本时间的交集，再去掉采音缺口。 */
export function effectiveSpeechMs(speech: readonly Interval[], gaps: readonly Interval[], segments: readonly TranscriptSegment[]): number {
  return intervalDuration(intersectIntervals(audibleSpeech(speech, gaps), segmentIntervals(segments)));
}
