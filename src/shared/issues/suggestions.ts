/** 规则模板文案。不调用 LLM。界面和规则引擎共用这一份。 */
export const RULE_SUGGESTIONS = {
  avoid: "停止相关表述，改用合规、可验证的描述。",
  paceSlow: "适当加快，减少无效重复。",
  paceFast: "放慢语速，在卖点和行动号召后停顿。",
  longPause: "把超长停顿收回来，停顿后接上卖点或互动。",
  lowDensity: "缩短空场，补充卖点或互动。",
  noPause: "在重点后留 1–2 秒停顿。",
  mustSayFallback: "补充近窗还没覆盖的必讲点。",
} as const;

export function cardSuggestion(issue: { suggestion?: string; ruleId: string }): string {
  const text = issue.suggestion?.trim();
  if (text) return text;
  switch (issue.ruleId) {
    case "content.avoid_hit":
      return RULE_SUGGESTIONS.avoid;
    case "content.must_say_missing":
      return RULE_SUGGESTIONS.mustSayFallback;
    case "pace.too_slow":
      return RULE_SUGGESTIONS.paceSlow;
    case "pace.too_fast":
      return RULE_SUGGESTIONS.paceFast;
    case "rhythm.long_pause":
      return RULE_SUGGESTIONS.longPause;
    case "rhythm.low_density":
      return RULE_SUGGESTIONS.lowDensity;
    case "rhythm.no_pause":
      return RULE_SUGGESTIONS.noPause;
    default:
      return "按问题类型调整这一小段口播。";
  }
}
