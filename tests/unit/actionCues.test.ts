import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { keywordMatches, matchFrameworkItems } from "../../src/main/analysis/match";
import {
  PRICE_KEYWORDS,
  SELLING_KEYWORDS,
  URGENCY_KEYWORDS,
  matchActionCue,
  textHasPriceMention,
} from "../../src/main/actions/cues";
import { parseActionConfig } from "../../src/main/actions/schema";
import { FrameworkStore } from "../../src/main/framework/FrameworkStore";
import { normalizeText } from "../../src/main/transcript/normalize";
import { defaultActionConfig } from "../../src/shared/contracts/actions";
import type { TranscriptSegment } from "../../src/shared/contracts/transcript";
import { ActionConfigPanel } from "../../src/renderer/features/actions/ActionConfigPanel";

const legacyPriceKeywords = ["活动价", "到手价", "秒杀价"];
const examplePath = path.join(process.cwd(), "frameworks", "example-framework.v0.json");

function segment(text: string, patch?: Partial<TranscriptSegment>): TranscriptSegment {
  return {
    id: patch?.id ?? "s",
    sessionId: "00000000-0000-4000-8000-000000000001",
    sourceResultId: "r",
    startMs: patch?.startMs ?? 0,
    endMs: patch?.endMs ?? 1_000,
    text,
    normalizedText: normalizeText(text),
    isFinal: true,
  };
}

describe("action cue lexicon", () => {
  it("misses livestream prices on the old ms-1 keywords and hits them after the expansion", () => {
    const missed = ["直播价", "专属价", "券后价", "三九九", "四九九", "五九九", "只要199", "39块", "39块钱", "到手88", "一号链接"];
    for (const text of missed) {
      expect(legacyPriceKeywords.some(keyword => keywordMatches(normalizeText(text), keyword))).toBe(false);
    }
    for (const text of ["直播价", "券后价", "三九九", "四九九", "五九九", "只要199", "39块", "39块钱", "到手88", "低至", "立减", "三百九十九元"]) {
      expect(textHasPriceMention(text)).toBe(true);
    }
    for (const text of ["一号链接", "只要好看", "第三代", "便宜", "划算", "下播"]) {
      expect(textHasPriceMention(text)).toBe(false);
    }

    const price = { id: "ms-1", text: "价格", keywords: [...legacyPriceKeywords] };
    expect(matchFrameworkItems([segment("只要199")], [price]).has("ms-1")).toBe(true);
    expect(matchFrameworkItems([segment("39块钱")], [price]).has("ms-1")).toBe(true);
    expect(matchFrameworkItems([segment("三九九")], [price]).has("ms-1")).toBe(true);
    expect(matchFrameworkItems([
      segment("只要", { id: "a", startMs: 0, endMs: 400 }),
      segment("199", { id: "b", startMs: 400, endMs: 800 }),
    ], [price]).has("ms-1")).toBe(true);
    expect(matchFrameworkItems([segment("一号链接")], [price]).has("ms-1")).toBe(false);
    expect(matchFrameworkItems([segment("第三代")], [price]).has("ms-1")).toBe(false);
    expect(matchFrameworkItems([segment("便宜")], [price]).has("ms-1")).toBe(false);
  });

  it("fires direct link and coupon phrases, and keeps weak words from firing alone", () => {
    for (const text of ["上链接", "挂链接", "一号链接", "八号链接", "11号链接", "小黄车", "直接拍"]) {
      expect(matchActionCue("stream.push_suggested", [segment(text)]).hit).toBe(true);
    }
    expect(matchActionCue("stream.push_suggested", [segment("一号链接")]).families)
      .toEqual(matchActionCue("stream.push_suggested", [segment("1号链接")]).families);
    expect(matchActionCue("stream.push_suggested", [segment("八号链接")]).families)
      .not.toEqual(matchActionCue("stream.push_suggested", [segment("一号链接")]).families);
    expect(matchActionCue("stream.push_suggested", [segment("第三代")]).hit).toBe(false);
    expect(matchActionCue("stream.push_suggested", [segment("第8代")]).hit).toBe(false);
    expect(matchActionCue("stream.push_suggested", [segment("胶原专利")]).hit).toBe(false);
    expect(matchActionCue("stream.push_suggested", [segment("胶原只要199")]).hit).toBe(true);
    expect(matchActionCue("stream.push_suggested", [segment("上链接就这一次")]).hit).toBe(true);

    for (const text of ["发券", "放券", "领券", "优惠券", "消费券", "头顶这个券", "右上角有券", "倒计时", "三十秒", "就这一次", "上链接就这一次"]) {
      expect(matchActionCue("coupon.issue_suggested", [segment(text)]).hit).toBe(true);
    }
    for (const text of ["下播", "只要", "便宜", "划算", "最后一波", "第三代", "第3代"]) {
      expect(matchActionCue("coupon.issue_suggested", [segment(text)]).hit).toBe(false);
      expect(matchActionCue("stream.push_suggested", [segment(text)]).hit).toBe(false);
    }
    expect(URGENCY_KEYWORDS).toContain("最后一波");
    expect(SELLING_KEYWORDS).not.toContain("第三代");
  });

  it("keeps the sample framework and default rules on the shared lists", () => {
    const loaded = new FrameworkStore().loadFile(examplePath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const byId = new Map(loaded.document.must_say.map(item => [item.id, item.keywords]));
    expect(byId.get("ms-1")).toEqual([...PRICE_KEYWORDS]);
    expect(byId.get("ms-2")).toEqual([...SELLING_KEYWORDS]);
    expect(byId.get("ms-3")).toEqual([...URGENCY_KEYWORDS]);

    const config = defaultActionConfig(loaded.revision, loaded.document.stages);
    expect(config.enabled).toBe(false);
    expect(config.rules.map(rule => rule.cooldownSeconds)).toEqual([180, 180]);
    expect(config.rules.map(rule => rule.stageIds)).toEqual([["pitch", "close"], ["pitch", "close"]]);
    expect(config.rules.every(rule => rule.requiredItemIds.length === 0)).toBe(true);
    config.enabled = true;
    config.rules.forEach(rule => { rule.enabled = true; });
    expect(parseActionConfig(config, loaded)).toEqual(config);

    const markup = renderToStaticMarkup(createElement(ActionConfigPanel, { framework: null, locked: false }));
    expect(markup).toContain("下次开始盯播");
    expect(markup).toContain("不必锁死一个阶段");
    expect(markup).toContain("180");
  });
});
