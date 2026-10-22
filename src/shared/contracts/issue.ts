export type IssueType = "content" | "pace" | "rhythm";
export type IssueSeverity = "info" | "warning" | "critical";
export type IssueStatus = "unread" | "read";

export type IssueExcerpt = {
  segmentId: string;
  text: string;
  startMs: number;
  endMs: number;
};

export type IssueEvidence = {
  windowStartMs: number;
  windowEndMs: number;
  segmentIds: string[];
  excerpts: IssueExcerpt[];
  frameworkItemIds: string[];
  metrics: Record<string, number | string | boolean>;
};

/** 同一次指纹命中的某一窗证据。只在回看投影里组装，不写入 JSONL。 */
export type IssueOccurrence = {
  windowStartMs: number;
  windowEndMs: number;
  excerpts: IssueExcerpt[];
  seenAtMs: number;
  recordedAt: string;
  occurrenceCount: number;
};

/** 问题卡直接展示的判定标准。旧场次 JSONL 没有这个字段。 */
export type IssueCriterion = {
  ruleId: string;
  summary: string;
  keywords?: string[];
  thresholds?: Array<{ label: string; value: string }>;
};

export type Issue = {
  id: string;
  sessionId: string;
  fingerprint: string;
  type: IssueType;
  ruleId: string;
  severity: IssueSeverity;
  title: string;
  suggestion?: string;
  criterion?: IssueCriterion;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  occurrenceCount: number;
  status: IssueStatus;
  frameworkRevision: string;
  evidence: IssueEvidence;
  /** 回看投影按指纹聚合成的历次证据窗。盯播内存和 JSONL 快照都不带这个字段。 */
  occurrences?: IssueOccurrence[];
};

/** 本场累计 must_say。text 是给界面用的，不参与规则判定。 */
export type CoverageItem = {
  frameworkItemId: string;
  text: string;
  covered: boolean;
  firstCoveredAtMs?: number;
  matchedSegmentIds: string[];
};

export type AnalysisDigest = {
  atMs: number;
  windowStartMs: number;
  windowEndMs: number;
  finalFlush: boolean;
  durationMs: number;
  audioCoverageMs: number;
  finalTextCoverageMs: number;
};

/** 同一问题再次命中时推给 Control 的重复提醒。 */
export type IssueRecurrence = {
  issueId: string;
  fingerprint: string;
  title: string;
  occurrenceCount: number;
  gapMs: number;
  seenAtMs: number;
};

export type IssuesUpdatedEvent = {
  sessionId: string;
  issues: Issue[];
  unreadCount: number;
  qualityWarning: string | null;
  lastAnalysis: AnalysisDigest | null;
  recurrences: IssueRecurrence[];
  issueRuleProfileName: string | null;
};

export type CoverageUpdatedEvent = {
  sessionId: string;
  items: CoverageItem[];
};

export type AnalysisSnapshot = {
  issues: Issue[];
  unreadCount: number;
  coverage: CoverageItem[];
  qualityWarning: string | null;
  lastAnalysis: AnalysisDigest | null;
  /** 只给中控用，Stage 投影不包含。 */
  pinnedIssueId: string | null;
  issueRuleProfileName: string | null;
};

export type MarkReadRequest = { id: string } | { all: true };
