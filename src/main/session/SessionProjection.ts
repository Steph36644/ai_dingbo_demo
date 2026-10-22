import { cardSuggestion } from "../../shared/issues/suggestions";
import type { Issue } from "../../shared/contracts/issue";
import type { SessionProjection as SessionProjectionType } from "../../shared/contracts/projection";
import type { SessionSnapshot } from "../../shared/contracts/session";
import type { StageHealth, StageView } from "../../shared/contracts/stage";
import type { FrameworkStage } from "../../shared/contracts/framework";
import type { ActionSignal } from "../../shared/contracts/actions";

export type ProjectionInput = {
  session: SessionSnapshot;
  issues: Issue[];
  stages: FrameworkStage[] | undefined;
  actionSignals?: ActionSignal[];
};

const SEVERITY_ORDER: Record<Issue["severity"], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/**
 * 主进程里的派生快照，专门喂两个表面。
 * Stage 不算优先级，也不读框架文件。
 */
export class SessionProjection {
  private stageId: string | null = null;
  private pinnedIssueId: string | null = null;
  private dismissedIssueIds = new Set<string>();
  private productNote: string | null = null;
  private listeners = new Set<(view: StageView) => void>();

  /** Control 完整投影，动作状态来自 Main。 */
  current(input: ProjectionInput): SessionProjectionType {
    const { session, issues, stages } = input;
    const stageLabel = this.resolveStageLabel(session, stages);
    const unread = issues.filter((issue) => issue.status === "unread");
    const suggestion = this.resolveSuggestion(unread);
    const health = this.resolveHealth(session.state);

    return {
      sessionId: session.sessionId,
      sessionState: session.state === "stopping" ? "idle" : session.state,
      stageId: this.stageId,
      stageLabel,
      pinnedIssueId: this.pinnedIssueId,
      dismissedIssueIds: [...this.dismissedIssueIds],
      unreadCount: unread.length,
      suggestion,
      health,
      productNote: this.productNote,
      actionSignals: input.actionSignals ?? [],
    };
  }

  /** 只给 Stage 的子集。 */
  stageView(input: ProjectionInput): StageView {
    const projection = this.current(input);
    return {
      sessionId: projection.sessionId,
      stageLabel: projection.stageLabel,
      unreadCount: projection.unreadCount,
      suggestion: projection.suggestion,
      health: projection.health,
    };
  }

  setStageId(stageId: string | null): void {
    this.stageId = stageId;
  }

  setPinnedIssueId(issueId: string | null): void {
    this.pinnedIssueId = issueId;
  }

  dismissIssue(issueId: string): void {
    this.dismissedIssueIds.add(issueId);
    if (this.pinnedIssueId === issueId) this.pinnedIssueId = null;
  }

  setProductNote(note: string | null): void {
    this.productNote = note?.trim() ? note.trim() : null;
  }

  /** 会话停止时清空 pin / dismiss / productNote。 */
  resetEphemeral(): void {
    this.stageId = null;
    this.pinnedIssueId = null;
    this.dismissedIssueIds.clear();
    this.productNote = null;
  }

  onPush(listener: (view: StageView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(view: StageView): void {
    for (const listener of this.listeners) listener(view);
  }

  private resolveStageLabel(session: SessionSnapshot, stages: FrameworkStage[] | undefined): string {
    if (!session.sessionId) return "未开播";
    if (!stages || stages.length === 0) return "直播中";
    const chosen = stages.find((stage) => stage.id === this.stageId) ?? stages[0];
    return chosen.name;
  }

  private resolveSuggestion(unread: Issue[]): string | null {
    if (this.pinnedIssueId) {
      const pinned = unread.find((issue) => issue.id === this.pinnedIssueId && !this.dismissedIssueIds.has(issue.id));
      if (pinned) return cardSuggestion(pinned);
    }
    const candidates = unread.filter((issue) => !this.dismissedIssueIds.has(issue.id));
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const rank = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (rank !== 0) return rank;
      return b.lastSeenAtMs - a.lastSeenAtMs;
    });
    return cardSuggestion(candidates[0]);
  }

  private resolveHealth(state: SessionSnapshot["state"]): StageHealth {
    if (state === "running" || state === "preparing") return "ok";
    if (state === "degraded") return "degraded";
    if (state === "error") return "error";
    return "idle";
  }
}
