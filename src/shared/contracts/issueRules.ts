import { QUALITY_GATES, RHYTHM_DEFAULTS } from "../config/defaults";
import type { IssueSeverity } from "./issue";

export const ISSUE_RULE_IDS = [
  "content.avoid_hit",
  "content.must_say_missing",
  "pace.too_fast",
  "pace.too_slow",
  "rhythm.long_pause",
  "rhythm.low_density",
  "rhythm.no_pause",
] as const;

export type IssueRuleId = (typeof ISSUE_RULE_IDS)[number];

export const BUILTIN_ISSUE_RULE_PROFILE_ID = "builtin-standard";
export const BUILTIN_ISSUE_RULE_PROFILE_NAME = "标准盯播方案";

export const ISSUE_RULE_PROFILE_LIMITS = {
  maxProfiles: 20,
  maxCustomRules: 30,
  maxKeywordsPerItem: 20,
  maxKeywordLength: 24,
  nameLength: 40,
  maxTitleLength: 60,
  maxSuggestionLength: 200,
  maxReminderIntervalMs: 600_000,
} as const;

export type CustomKeywordRule = {
  id: string;
  name: string;
  keywords: string[];
  severity: IssueSeverity;
  suggestion: string;
  enabled: boolean;
};

export type IssueRuleProfile = {
  id: string;
  name: string;
  updatedAt: string;
  avoid: {
    enabled: boolean;
    severity: IssueSeverity;
    disabledItemIds: string[];
  };
  mustSay: {
    enabled: boolean;
    severity: IssueSeverity;
    missWindows: number;
    disabledItemIds: string[];
  };
  pace: {
    enabled: boolean;
    severity: IssueSeverity | null;
    min: number | null;
    max: number | null;
    deviationInfoRatio: number;
  };
  rhythm: {
    enabled: boolean;
    severity: IssueSeverity;
    longPauseEnabled: boolean;
    longSilenceMs: number;
    lowDensityEnabled: boolean;
    highSilenceRatio: number;
    noPauseEnabled: boolean;
    highSpeechRatio: number;
    minDenseSpeechMs: number;
    maxSentenceGapMs: number;
  };
  keywordOverrides: Record<string, string[]>;
  customRules: CustomKeywordRule[];
  titles: Record<string, string>;
  suggestions: Record<string, string>;
  repeatReminderIntervalMs: number;
};

export type IssueRuleProfileView = {
  id: string;
  name: string;
  updatedAt: string;
  builtin: boolean;
};

export type IssueRuleProfilesState = {
  profiles: IssueRuleProfileView[];
  activeProfileId: string;
  activeProfile: IssueRuleProfile;
  warning: string | null;
};

export type IssueRuleActionResult = {
  ok: boolean;
  message?: string;
  state: IssueRuleProfilesState;
};

export type IssueRuleProfileInput = IssueRuleProfile;

export function defaultIssueRuleProfile(
  name: string = BUILTIN_ISSUE_RULE_PROFILE_NAME,
  id: string = BUILTIN_ISSUE_RULE_PROFILE_ID,
  updatedAt: string = new Date(0).toISOString(),
): IssueRuleProfile {
  return {
    id,
    name,
    updatedAt,
    avoid: { enabled: true, severity: "critical", disabledItemIds: [] },
    mustSay: { enabled: true, severity: "warning", missWindows: 2, disabledItemIds: [] },
    pace: {
      enabled: true,
      severity: null,
      min: null,
      max: null,
      deviationInfoRatio: QUALITY_GATES.paceDeviationInfo,
    },
    rhythm: {
      enabled: true,
      severity: "warning",
      longPauseEnabled: true,
      longSilenceMs: RHYTHM_DEFAULTS.longSilenceMs,
      lowDensityEnabled: true,
      highSilenceRatio: RHYTHM_DEFAULTS.highSilenceRatio,
      noPauseEnabled: true,
      highSpeechRatio: RHYTHM_DEFAULTS.highSpeechRatio,
      minDenseSpeechMs: RHYTHM_DEFAULTS.minDenseSpeechMs,
      maxSentenceGapMs: RHYTHM_DEFAULTS.maxSentenceGapMs,
    },
    keywordOverrides: {},
    customRules: [],
    titles: {},
    suggestions: {},
    repeatReminderIntervalMs: 0,
  };
}

export function cloneIssueRuleProfile(profile: IssueRuleProfile): IssueRuleProfile {
  return structuredClone(profile);
}

export function customRuleItemId(ruleId: string): string {
  return `custom:${ruleId}`;
}
