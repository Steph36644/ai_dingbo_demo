import type { ActionSignalKind } from "@shared/contracts/actions";
import { normalizeText } from "../transcript/normalize";

/**
 * 推流 / 发券口播线索的唯一词表。
 * 示例框架 ms-1 / ms-2 / ms-3 与这里保持同一份字面词；
 * 「只要 + 邻近数字」「N号链接」这类形态只在匹配函数里，不写进框架关键词。
 * 故意不收：第N代、单独的下播 / 只要 / 便宜 / 划算 / 最后一波。
 */

/** 价格字面词。ms-1 覆盖和「卖点 + 价格」加成共用。 */
export const PRICE_KEYWORDS = [
  "活动价",
  "到手价",
  "秒杀价",
  "直播价",
  "专属价",
  "福利价",
  "券后价",
  "折后价",
  "优惠价",
  "特价",
  "现价",
  "低至",
  "降至",
  "降到",
  "砍到",
  "立减",
  "直降",
  "原价",
  "三九九",
  "四九九",
  "五九九",
] as const;

/** 卖点。单独出现不触发推流，同一分析窗里还要有链接或价格。 */
export const SELLING_KEYWORDS = [
  "卖点",
  "成分",
  "效果",
  "专利",
  "功效",
  "环肽",
  "胶原",
  "修护",
  "抗老",
  "紧致",
  "保湿",
  "美白",
  "提亮",
] as const;

/**
 * 促单、库存和链接/券语境。给示例框架 ms-3 做覆盖。
 * 其中「最后一波」只参与讲点覆盖，不是发券的单独触发。
 */
export const URGENCY_KEYWORDS = [
  "仅剩",
  "库存",
  "名额",
  "拍下",
  "倒计时",
  "最后一波",
  "三十秒",
  "就这一次",
  "发券",
  "放券",
  "领券",
  "优惠券",
  "消费券",
  "上链接",
  "挂链接",
  "小黄车",
  "直接拍",
] as const;

const PUSH_LINK_LITERALS = ["上链接", "挂链接", "小黄车", "直接拍"] as const;
const COUPON_LITERALS = ["发券", "放券", "领券", "优惠券", "消费券"] as const;
const COUPON_URGENCY = ["倒计时", "三十秒", "就这一次", "上链接就这一次"] as const;

const PRICE_KEYWORD_SET = new Set<string>(PRICE_KEYWORDS.map((keyword) => normalizeText(keyword)));
const NEARBY_RADIUS = 12;
const ARABIC_PRICE = /(?<![0-9])[0-9]{1,6}(?:块钱|块|元)/;
const CHINESE_NINE_PRICE = /[一二三四五六七八九两]九九/;
const CHINESE_UNIT_PRICE = /[一二三四五六七八九两]百[零一二三四五六七八九十两]{0,3}(?:块钱|块|元)|[一二三四五六七八九两]?十[一二三四五六七八九两]?(?:块钱|块|元)/;
const NEARBY_NUMBER = /[0-9]{2,6}|[0-9](?:块钱|块|元)|[一二三四五六七八九两]九九|[一二三四五六七八九两]百|[一二三四五六七八九两]?十[一二三四五六七八九两]?(?:块钱|块|元)/;
const SLOT_CHAR = /[0-9零一二三四五六七八九十两]/;

const CN_DIGIT: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

export type CueSegment = {
  id: string;
  normalizedText: string;
  startMs?: number;
  endMs?: number;
};

export type CueMatch = {
  hit: boolean;
  families: string[];
  labels: string[];
  segmentIds: string[];
};

type CuePhrase = { family: string; label: string };

export function keywordsUsePriceLexicon(keywords: readonly string[]): boolean {
  return keywords.some((keyword) => PRICE_KEYWORD_SET.has(normalizeText(keyword)));
}

/** 价格口径：字面词、数字价、中文档口价，以及「只要 / 到手」旁边的数字。单独的「只要」不算。 */
export function textHasPriceMention(input: string): boolean {
  const text = normalizeText(input);
  if (!text) return false;
  if (PRICE_KEYWORDS.some((keyword) => text.includes(normalizeText(keyword)))) return true;
  if (ARABIC_PRICE.test(text) || CHINESE_NINE_PRICE.test(text) || CHINESE_UNIT_PRICE.test(text)) return true;
  return hasNearbyNumber(text, "只要") || hasNearbyNumber(text, "到手");
}

export function matchActionCue(kind: ActionSignalKind, segments: readonly CueSegment[]): CueMatch {
  const ordered = [...segments].sort(
    (a, b) => (a.startMs ?? 0) - (b.startMs ?? 0) || (a.endMs ?? 0) - (b.endMs ?? 0),
  );
  const joined = ordered.map((segment) => segment.normalizedText).join("");
  const found = kind === "stream.push_suggested" ? pushCues(joined) : couponCues(joined);
  if (found.length === 0) return { hit: false, families: [], labels: [], segmentIds: [] };
  const segmentIds = ordered
    .filter((segment) => (kind === "stream.push_suggested" ? pushCues(segment.normalizedText) : couponCues(segment.normalizedText)).length > 0)
    .map((segment) => segment.id);
  return {
    hit: true,
    families: found.map((item) => item.family),
    labels: found.map((item) => item.label),
    segmentIds: segmentIds.length > 0 ? segmentIds : ordered.map((segment) => segment.id),
  };
}

function pushCues(text: string): CuePhrase[] {
  const found: CuePhrase[] = [];
  for (const literal of PUSH_LINK_LITERALS) {
    if (text.includes(literal)) addPhrase(found, `push:${literal}`, literal);
  }
  for (const slot of slotLinks(text)) addPhrase(found, slot.family, slot.label);
  if (found.length > 0) return found;
  if (mentionsSelling(text) && textHasPriceMention(text)) {
    return [{ family: "push:卖点价格", label: "卖点与价格" }];
  }
  return [];
}

function couponCues(text: string): CuePhrase[] {
  const found: CuePhrase[] = [];
  for (const literal of COUPON_LITERALS) {
    if (text.includes(literal)) addPhrase(found, `coupon:${literal}`, literal);
  }
  if (/头顶.{0,12}券/.test(text)) addPhrase(found, "coupon:头顶券", "头顶券");
  if (/右上角.{0,12}券/.test(text)) addPhrase(found, "coupon:右上角券", "右上角券");
  for (const literal of COUPON_URGENCY) {
    if (text.includes(literal)) addPhrase(found, `coupon:${literal}`, literal);
  }
  return found;
}

function mentionsSelling(text: string): boolean {
  return SELLING_KEYWORDS.some((keyword) => text.includes(normalizeText(keyword)));
}

function slotLinks(text: string): CuePhrase[] {
  const found: CuePhrase[] = [];
  const needle = "号链接";
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    let start = at;
    while (start > 0 && SLOT_CHAR.test(text[start - 1] ?? "")) start -= 1;
    const raw = text.slice(start, at);
    if (raw) addPhrase(found, `push:号链接:${normalizeSlot(raw)}`, `${raw}号链接`);
    from = at + needle.length;
  }
  return found;
}

function normalizeSlot(raw: string): string {
  if (/^\d+$/.test(raw)) return String(Number(raw));
  if (raw === "十") return "10";
  if (/^十[一二三四五六七八九两]$/.test(raw)) return String(10 + (CN_DIGIT[raw[1] ?? ""] ?? 0));
  if (/^[一二三四五六七八九两]十$/.test(raw)) return String((CN_DIGIT[raw[0] ?? ""] ?? 0) * 10);
  if (/^[一二三四五六七八九两]十[一二三四五六七八九两]$/.test(raw)) {
    return String((CN_DIGIT[raw[0] ?? ""] ?? 0) * 10 + (CN_DIGIT[raw[2] ?? ""] ?? 0));
  }
  if (raw.length === 1 && CN_DIGIT[raw] != null) return String(CN_DIGIT[raw]);
  return raw;
}

function hasNearbyNumber(text: string, anchor: string): boolean {
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(anchor, from);
    if (at < 0) return false;
    const slice = text.slice(Math.max(0, at - NEARBY_RADIUS), Math.min(text.length, at + anchor.length + NEARBY_RADIUS));
    if (NEARBY_NUMBER.test(slice)) return true;
    from = at + anchor.length;
  }
  return false;
}

function addPhrase(found: CuePhrase[], family: string, label: string): void {
  if (found.some((item) => item.family === family)) return;
  found.push({ family, label });
}
