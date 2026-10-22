import { randomUUID } from "node:crypto";
import type { Issue, IssueRecurrence, IssueSeverity } from "@shared/contracts/issue";
import type { IssueCandidate } from "./RuleEngine";

const SEVERITY_RANK: Record<IssueSeverity, number> = { critical: 0, warning: 1, info: 2 };

export type IssueUpsertResult = {
  issue: Issue;
  isNew: boolean;
  recurrence: IssueRecurrence | null;
};

export class IssueStore {
  private issues: Issue[] = [];
  private sessionId = "";

  reset(sessionId: string): void {
    this.sessionId = sessionId;
    this.issues = [];
  }

  upsert(candidate: IssueCandidate, seenAtMs: number, frameworkRevision: string): IssueUpsertResult {
    const index = this.issues.findIndex((issue) => issue.fingerprint === candidate.fingerprint);
    if (index < 0) {
      const issue: Issue = {
        id: randomUUID(),
        sessionId: this.sessionId,
        fingerprint: candidate.fingerprint,
        type: candidate.type,
        ruleId: candidate.ruleId,
        severity: candidate.severity,
        title: candidate.title,
        suggestion: candidate.suggestion,
        criterion: candidate.criterion,
        firstSeenAtMs: seenAtMs,
        lastSeenAtMs: seenAtMs,
        occurrenceCount: 1,
        status: "unread",
        frameworkRevision,
        evidence: candidate.evidence,
      };
      this.issues.push(issue);
      return { issue: structuredClone(issue), isNew: true, recurrence: null };
    }
    const current = this.issues[index];
    if (!current) {
      throw new Error("issue index out of range");
    }
    const gapMs = seenAtMs - current.lastSeenAtMs;
    const issue: Issue = {
      ...current,
      type: candidate.type,
      ruleId: candidate.ruleId,
      severity: candidate.severity,
      title: candidate.title,
      suggestion: candidate.suggestion,
      criterion: candidate.criterion,
      lastSeenAtMs: seenAtMs,
      occurrenceCount: current.occurrenceCount + 1,
      // 重复出现必须重新提醒：即使刚被标记已读，也回到未读。
      status: "unread",
      frameworkRevision,
      evidence: candidate.evidence,
    };
    this.issues[index] = issue;
    return {
      issue: structuredClone(issue),
      isNew: false,
      recurrence: {
        issueId: issue.id,
        fingerprint: issue.fingerprint,
        title: issue.title,
        occurrenceCount: issue.occurrenceCount,
        gapMs,
        seenAtMs,
      },
    };
  }

  markRead(id: string): void {
    this.issues = this.issues.map((issue) => (issue.id === id ? { ...issue, status: "read" } : issue));
  }

  markAllRead(): void {
    this.issues = this.issues.map((issue) => ({ ...issue, status: "read" as const }));
  }

  list(): Issue[] {
    return [...this.issues]
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.lastSeenAtMs - a.lastSeenAtMs || a.id.localeCompare(b.id))
      .map((issue) => structuredClone(issue));
  }

  unreadCount(): number {
    return this.issues.filter((issue) => issue.status === "unread").length;
  }
}
