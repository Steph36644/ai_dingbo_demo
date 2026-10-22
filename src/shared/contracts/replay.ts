import type { Issue, IssueOccurrence } from "./issue";
import type { ActionHistory } from "./actions";

/** 与主进程复盘目录校验同一条规则。Renderer 只能交这个 id，不能交文件路径。 */
export const REPLAY_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isReplaySessionId(value: string): boolean {
  return REPLAY_SESSION_ID.test(value);
}

export type ReplayIssue = Issue & { occurrences: IssueOccurrence[] };

export type ReplayTranscriptEntry = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
};

export type ReplaySummary = {
  sessionId: string;
  startedAt: string;
  stoppedAt: string;
  durationMs: number;
  finalCount: number;
  issueCount: number;
  frameworkTitle: string | null;
  frameworkRevision: string | null;
};

export type SessionReplayView = {
  summary: ReplaySummary;
  issues: ReplayIssue[];
  finals: ReplayTranscriptEntry[];
  /** 独立附属文件投影；不改变 session.jsonl。旧场次可缺省。 */
  actionHistory?: ActionHistory;
};

export type SessionReplayResult =
  | { ok: true; replay: SessionReplayView }
  | { ok: false; code: "unavailable" | "read_failed" | "invalid"; message: string };

/** 目录项不含文件路径。Renderer 用 sessionId 再向主进程要投影。 */
export type SessionCatalogEntry = {
  sessionId: string;
  startedAt: string;
  stoppedAt: string;
  durationMs: number;
  finalCount: number;
  issueCount: number;
  frameworkTitle: string | null;
  /** 主播在目录里给这场起的名字；未起名时主进程按开播时间生成。 */
  displayTitle: string;
};

export type SessionCatalogResult =
  | { ok: true; sessions: SessionCatalogEntry[]; truncated: boolean }
  | { ok: false; code: "read_failed"; message: string };

export type SessionRenameRequest = {
  sessionId: string;
  /** 空字符串表示清除自定义名，回到按时间命名。 */
  title: string;
};

export type SessionRenameResult =
  | { ok: true; entry: SessionCatalogEntry }
  | { ok: false; code: "invalid" | "read_failed" | "write_failed"; message: string };
