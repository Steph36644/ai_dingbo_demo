import type { FrameworkDocument, FrameworkItem } from "@shared/contracts/framework";
import { customRuleItemId, type IssueRuleProfile } from "@shared/contracts/issueRules";

/** 把警告方案叠加到框架文件上，返回本次盯播实际使用的规则副本。 */
export function effectiveFramework(
  document: FrameworkDocument,
  profile: IssueRuleProfile,
): FrameworkDocument {
  return {
    ...document,
    pace: {
      ...document.pace,
      min: profile.pace.min ?? document.pace.min,
      max: profile.pace.max ?? document.pace.max,
    },
    must_say: applyItems(document.must_say, profile, profile.mustSay.disabledItemIds),
    avoid: applyItems(document.avoid, profile, profile.avoid.disabledItemIds),
    stages: document.stages?.map((stage) => ({ ...stage })),
  };
}

export function customRuleItems(profile: IssueRuleProfile): FrameworkItem[] {
  return profile.customRules
    .filter((rule) => rule.enabled)
    .map((rule) => ({
      id: customRuleItemId(rule.id),
      text: rule.name,
      keywords: [...rule.keywords],
    }));
}

export function customRuleHotwords(profile: IssueRuleProfile): string[] {
  return profile.customRules
    .filter((rule) => rule.enabled)
    .flatMap((rule) => rule.keywords);
}

function applyItems(
  items: readonly FrameworkItem[],
  profile: IssueRuleProfile,
  disabledItemIds: readonly string[],
): FrameworkItem[] {
  const disabled = new Set(disabledItemIds);
  return items
    .filter((item) => !disabled.has(item.id))
    .map((item) => {
      const override = profile.keywordOverrides[item.id];
      return {
        ...item,
        keywords: override && override.length > 0 ? [...override] : [...item.keywords],
      };
    });
}
