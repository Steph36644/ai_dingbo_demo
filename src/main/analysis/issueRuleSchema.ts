import { z } from "zod";
import { ISSUE_RULE_PROFILE_LIMITS, type IssueRuleProfile } from "@shared/contracts/issueRules";

const severity = z.enum(["info", "warning", "critical"]);
const itemId = z.string().trim().min(1).max(120);

function keywordList() {
  return z
    .array(z.string().trim().min(1).max(ISSUE_RULE_PROFILE_LIMITS.maxKeywordLength))
    .max(ISSUE_RULE_PROFILE_LIMITS.maxKeywordsPerItem)
    .transform((words) => [...new Set(words.map((word) => word.trim()).filter(Boolean))]);
}

const titleRecord = z
  .record(
    itemId,
    z.string().trim().max(ISSUE_RULE_PROFILE_LIMITS.maxTitleLength),
  )
  .refine((value) => Object.keys(value).length <= 200, { message: "标题覆盖过多" });

const suggestionRecord = z
  .record(
    itemId,
    z.string().trim().max(ISSUE_RULE_PROFILE_LIMITS.maxSuggestionLength),
  )
  .refine((value) => Object.keys(value).length <= 200, { message: "建议覆盖过多" });

const keywordOverrideRecord = z
  .record(itemId, keywordList())
  .refine((value) => Object.keys(value).length <= 500, { message: "关键词覆盖过多" });

const customRuleSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(ISSUE_RULE_PROFILE_LIMITS.nameLength),
    keywords: keywordList().refine((words) => words.length > 0, { message: "自定义规则至少需要一个关键词" }),
    severity,
    suggestion: z.string().trim().max(ISSUE_RULE_PROFILE_LIMITS.maxSuggestionLength),
    enabled: z.boolean(),
  })
  .strict();

const paceSchema = z
  .object({
    enabled: z.boolean(),
    severity: severity.nullable(),
    min: z.number().int().min(1).max(2000).nullable(),
    max: z.number().int().min(1).max(2000).nullable(),
    deviationInfoRatio: z.number().min(0).max(1),
  })
  .strict()
  .refine((value) => value.min == null || value.max == null || value.min < value.max, {
    message: "语速下限必须小于上限",
  });

export const issueRuleProfileSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(ISSUE_RULE_PROFILE_LIMITS.nameLength),
    updatedAt: z.string().trim().min(1).max(40),
    avoid: z
      .object({
        enabled: z.boolean(),
        severity,
        disabledItemIds: z.array(itemId).max(200),
      })
      .strict(),
    mustSay: z
      .object({
        enabled: z.boolean(),
        severity,
        missWindows: z.number().int().min(1).max(10),
        disabledItemIds: z.array(itemId).max(200),
      })
      .strict(),
    pace: paceSchema,
    rhythm: z
      .object({
        enabled: z.boolean(),
        severity,
        longPauseEnabled: z.boolean(),
        longSilenceMs: z.number().int().min(1_000).max(60_000),
        lowDensityEnabled: z.boolean(),
        highSilenceRatio: z.number().min(0).max(1),
        noPauseEnabled: z.boolean(),
        highSpeechRatio: z.number().min(0).max(1),
        minDenseSpeechMs: z.number().int().min(15_000).max(300_000),
        maxSentenceGapMs: z.number().int().min(200).max(5_000),
      })
      .strict(),
    keywordOverrides: keywordOverrideRecord,
    customRules: z.array(customRuleSchema).max(ISSUE_RULE_PROFILE_LIMITS.maxCustomRules),
    titles: titleRecord,
    suggestions: suggestionRecord,
    repeatReminderIntervalMs: z
      .number()
      .int()
      .min(0)
      .max(ISSUE_RULE_PROFILE_LIMITS.maxReminderIntervalMs),
  })
  .strict();

export const issueRuleStateFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    activeProfileId: z.string().trim().min(1).max(120),
    profiles: z.array(issueRuleProfileSchema).max(ISSUE_RULE_PROFILE_LIMITS.maxProfiles),
  })
  .strict();

export function parseIssueRuleProfileInput(raw: unknown): IssueRuleProfile | null {
  const parsed = issueRuleProfileSchema.safeParse(raw);
  return parsed.success ? (parsed.data as IssueRuleProfile) : null;
}
