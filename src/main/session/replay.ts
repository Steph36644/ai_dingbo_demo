import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Issue, IssueSeverity } from "@shared/contracts/issue";
import {
  isReplaySessionId,
  type ReplayIssue,
  type SessionCatalogEntry,
  type SessionCatalogResult,
  type SessionRenameResult,
  type SessionReplayResult,
  type SessionReplayView,
} from "@shared/contracts/replay";
import { redactReplayValue, redactText } from "../security/redact";

export const REPLAY_SCHEMA_VERSION = 1;

export const REPLAY_EVENT_TYPES = [
  "session_started",
  "framework_loaded",
  "transcript_final",
  "audio_gap",
  "analysis_completed",
  "issue_upserted",
  "session_stopped",
] as const;

export type ReplayEventType = (typeof REPLAY_EVENT_TYPES)[number];

export type ReplayEvent = {
  schemaVersion: typeof REPLAY_SCHEMA_VERSION;
  sessionId: string;
  recordedAt: string;
  type: ReplayEventType;
  payload: Record<string, unknown>;
};

export type ReplayWriteResult = { ok: true; filePath: string } | { ok: false; message: string };

export const REPLAY_READ_LIMITS = { maxBytes: 64 * 1024 * 1024, maxEvents: 200_000 } as const;
export const SESSION_CATALOG_LIMIT = 200;
const SEVERITY_RANK: Record<IssueSeverity, number> = { critical: 0, warning: 1, info: 2 };

const WRITE_FAILURE = "复盘文件没有写成，本场数据仍留在内存里，关闭窗口后会丢失。";

export class SessionJournal {
  readonly events: ReplayEvent[] = [];

  constructor(
    private readonly sessionId: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  append(type: ReplayEventType, payload: Record<string, unknown>): void {
    if (this.events.length === 0 && type !== "session_started") {
      throw new Error("复盘首条事件必须是 session_started");
    }
    if (this.events.at(-1)?.type === "session_stopped") return;
    this.events.push({
      schemaVersion: REPLAY_SCHEMA_VERSION,
      sessionId: this.sessionId,
      recordedAt: this.now(),
      type,
      payload,
    });
  }
}

export function sessionReplayPath(root: string, sessionId: string): string {
  if (!isReplaySessionId(sessionId)) throw new Error("会话 ID 不能作为复盘目录");
  return path.join(root, "sessions", sessionId, "session.jsonl");
}

export function sessionMetaPath(root: string, sessionId: string): string {
  if (!isReplaySessionId(sessionId)) throw new Error("会话 ID 不能作为复盘目录");
  return path.join(root, "sessions", sessionId, "meta.json");
}

/** 主播自定义名。只存到 meta.json，不动 session.jsonl（保持只读事实）。 */
export type SessionMeta = {
  customTitle?: string;
};

export function readSessionMeta(root: string, sessionId: string): SessionMeta {
  let filePath: string;
  try {
    filePath = sessionMetaPath(root, sessionId);
  } catch {
    return {};
  }
  if (!existsSync(filePath)) return {};
  try {
    const text = readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return {};
    const custom = (parsed as { customTitle?: unknown }).customTitle;
    return typeof custom === "string" && custom.trim() ? { customTitle: custom.trim() } : {};
  } catch {
    return {};
  }
}

export function writeSessionMeta(root: string, sessionId: string, meta: SessionMeta): { ok: boolean; message?: string } {
  let filePath: string;
  try {
    filePath = sessionMetaPath(root, sessionId);
  } catch {
    return { ok: false, message: "场次编号不合法。" };
  }
  try {
    const dir = path.dirname(filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const body = JSON.stringify(meta, null, 2) + "\n";
    writeFileSync(filePath, body, { encoding: "utf8", mode: 0o600 });
    chmodBestEffort(filePath, 0o600);
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? redactText(error.message) : "IO 错误";
    return { ok: false, message: `场次命名没有保存下来（${detail}）。` };
  }
}

/** 未起名时按开播时间生成「YYYY/M/D HH:mm」。 */
export function defaultCatalogTitle(startedAt: string): string {
  const parsed = Date.parse(startedAt);
  if (!Number.isFinite(parsed)) return "未命名场次";
  const date = new Date(parsed);
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

export function writeSessionReplay(root: string, sessionId: string, events: readonly ReplayEvent[]): ReplayWriteResult {
  try {
    if (events.length === 0 || events[0]?.type !== "session_started") {
      return { ok: false, message: WRITE_FAILURE };
    }
    if (events.at(-1)?.type !== "session_stopped") {
      return { ok: false, message: WRITE_FAILURE };
    }
    const filePath = sessionReplayPath(root, sessionId);
    const dir = path.dirname(filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodBestEffort(dir, 0o700);
    const body = events.map((event) => JSON.stringify(redactEvent(event))).join("\n") + "\n";
    writeFileSync(filePath, body, { encoding: "utf8", mode: 0o600 });
    chmodBestEffort(filePath, 0o600);
    return { ok: true, filePath };
  } catch (error) {
    const detail = error instanceof Error ? redactText(error.message) : "IO 错误";
    return { ok: false, message: `${WRITE_FAILURE}${detail ? `（${detail}）` : ""}` };
  }
}

export function loadSessionReplay(filePath: string): ReplayEvent[] {
  if (statSync(filePath).size > REPLAY_READ_LIMITS.maxBytes) throw new Error("复盘文件超过 64 MB，不能在看台中打开");
  const text = readFileSync(filePath, "utf8");
  const events: ReplayEvent[] = [];
  const lines = text.split(/\n/);
  let sessionId: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    if (events.length >= REPLAY_READ_LIMITS.maxEvents) throw new Error("复盘事件超过 200000 条，不能在看台中打开");
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`复盘第 ${index + 1} 行不是合法 JSON`);
    }
    if (!isReplayEvent(parsed)) throw new Error(`复盘第 ${index + 1} 行不是合法事件`);
    if (sessionId !== null && parsed.sessionId !== sessionId) throw new Error("复盘包含多个会话 ID，已拒绝载入");
    sessionId ??= parsed.sessionId;
    events.push(parsed);
  }
  if (events[0]?.type !== "session_started") throw new Error("复盘首行必须是 session_started");
  if (events.at(-1)?.type !== "session_stopped") throw new Error("复盘末行必须是 session_stopped");
  if (!sessionId || !isReplaySessionId(sessionId)) throw new Error("复盘会话 ID 不合法");
  for (const event of events) {
    if (!Number.isFinite(Date.parse(event.recordedAt))) throw new Error("复盘 recordedAt 不是合法时间");
  }
  return events;
}

export function listSessionReplays(root: string): SessionCatalogResult {
  const dir = path.join(root, "sessions");
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return { ok: true, sessions: [], truncated: false };
    return { ok: false, code: "read_failed", message: "历史场次目录读取失败。" };
  }
  const sessions: SessionCatalogEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isReplaySessionId(entry.name)) continue;
    let filePath: string;
    try {
      filePath = sessionReplayPath(root, entry.name);
    } catch {
      continue;
    }
    if (!existsSync(filePath)) continue;
    try {
      const summary = projectSessionReplay(loadSessionReplay(filePath)).summary;
      const customTitle = readSessionMeta(root, entry.name).customTitle ?? null;
      sessions.push(toCatalogEntry(summary, customTitle));
    } catch {
      continue;
    }
  }
  sessions.sort((left, right) => Date.parse(right.stoppedAt) - Date.parse(left.stoppedAt) || right.sessionId.localeCompare(left.sessionId));
  return {
    ok: true,
    truncated: sessions.length > SESSION_CATALOG_LIMIT,
    sessions: sessions.slice(0, SESSION_CATALOG_LIMIT),
  };
}

export function renameSessionReplay(root: string, sessionId: string, title: string): SessionRenameResult {
  if (!isReplaySessionId(sessionId)) {
    return { ok: false, code: "invalid", message: "场次编号不合法。" };
  }
  let filePath: string;
  try {
    filePath = sessionReplayPath(root, sessionId);
  } catch {
    return { ok: false, code: "invalid", message: "场次编号不合法。" };
  }
  if (!existsSync(filePath)) {
    return { ok: false, code: "read_failed", message: "没有找到这场的复盘文件。" };
  }
  const trimmed = title.trim();
  if (trimmed.length > 60) {
    return { ok: false, code: "invalid", message: "名字最长 60 字。" };
  }
  const write = writeSessionMeta(root, sessionId, trimmed ? { customTitle: trimmed } : {});
  if (!write.ok) {
    return { ok: false, code: "write_failed", message: write.message ?? "场次命名没有保存下来。" };
  }
  let summary: SessionReplayView["summary"];
  try {
    summary = projectSessionReplay(loadSessionReplay(filePath)).summary;
  } catch (error) {
    const detail = error instanceof Error ? redactText(error.message) : "无法读取复盘文件";
    return { ok: false, code: "read_failed", message: `场次已写入新名字，但读取目录失败：${detail}` };
  }
  const customTitle = readSessionMeta(root, sessionId).customTitle ?? null;
  return { ok: true, entry: toCatalogEntry(summary, customTitle) };
}

export function readSessionReplayById(root: string, sessionId: string): SessionReplayResult {
  if (!isReplaySessionId(sessionId)) {
    return { ok: false, code: "invalid", message: "场次编号不合法，不能打开。" };
  }
  let filePath: string;
  try {
    filePath = sessionReplayPath(root, sessionId);
  } catch {
    return { ok: false, code: "invalid", message: "场次编号不合法，不能打开。" };
  }
  if (!existsSync(filePath)) {
    return { ok: false, code: "unavailable", message: "没有找到这场的复盘文件。" };
  }
  return readCurrentSessionReplay(filePath, true);
}

export function readCurrentSessionReplay(filePath: string | null, canRead: boolean): SessionReplayResult {
  if (!canRead || !filePath) {
    return { ok: false, code: "unavailable", message: "当前没有已写入 JSONL 的已结束场次。" };
  }
  try {
    return { ok: true, replay: projectSessionReplay(loadSessionReplay(filePath)) };
  } catch (error) {
    const detail = error instanceof Error ? redactText(error.message) : "无法读取复盘文件";
    const invalid = !/no such file|cannot find|permission|denied|ENOENT|EPERM|EACCES/i.test(detail);
    return {
      ok: false,
      code: invalid ? "invalid" : "read_failed",
      message: `本场 JSONL 回看读取失败：${detail}`,
    };
  }
}

export function projectSessionReplay(events: readonly ReplayEvent[]): SessionReplayView {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last || first.sessionId !== last.sessionId) throw new Error("复盘缺少一致的会话边界");
  const finals = replayFinals(events).sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const issues = replayIssues(events);
  const framework = events.find((event) => event.type === "framework_loaded");
  const stoppedPayload = last.payload;
  const audioClockMs = typeof stoppedPayload.audioClockMs === "number" ? stoppedPayload.audioClockMs : 0;
  const finalEndMs = finals.at(-1)?.endMs ?? 0;
  return {
    summary: {
      sessionId: first.sessionId,
      startedAt: first.recordedAt,
      stoppedAt: last.recordedAt,
      durationMs: Math.max(0, audioClockMs, finalEndMs),
      finalCount: finals.length,
      issueCount: issues.length,
      frameworkTitle: typeof framework?.payload.title === "string" ? framework.payload.title : null,
      frameworkRevision: typeof framework?.payload.revision === "string" ? framework.payload.revision : null,
    },
    issues,
    finals,
  };
}

export function replayIssues(events: readonly ReplayEvent[]): ReplayIssue[] {
  const byFingerprint = new Map<string, ReplayIssue>();
  for (const event of events) {
    if (event.type !== "issue_upserted") continue;
    const issue = event.payload.issue;
    if (!isIssue(issue)) throw new Error("复盘包含不完整的问题证据");
    if (issue.sessionId !== event.sessionId) throw new Error("复盘问题与会话 ID 不一致");
    const occurrence = {
      windowStartMs: issue.evidence.windowStartMs,
      windowEndMs: issue.evidence.windowEndMs,
      excerpts: issue.evidence.excerpts.map((excerpt) => ({ ...excerpt })),
      seenAtMs: issue.lastSeenAtMs,
      recordedAt: event.recordedAt,
      occurrenceCount: issue.occurrenceCount,
    };
    const previous = byFingerprint.get(issue.fingerprint);
    byFingerprint.set(issue.fingerprint, {
      ...issueSnapshot(issue),
      occurrences: [...(previous?.occurrences ?? []), occurrence],
    });
  }
  return [...byFingerprint.values()]
    .map((issue) => ({
      ...issue,
      occurrences: [...issue.occurrences].sort((left, right) =>
        left.seenAtMs - right.seenAtMs || left.recordedAt.localeCompare(right.recordedAt) || left.occurrenceCount - right.occurrenceCount),
    }))
    .sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] || right.lastSeenAtMs - left.lastSeenAtMs || left.id.localeCompare(right.id));
}

function issueSnapshot(issue: Issue): Omit<Issue, "occurrences"> {
  const snapshot = { ...issue };
  delete snapshot.occurrences;
  return snapshot;
}

function toCatalogEntry(summary: SessionReplayView["summary"], customTitle: string | null): SessionCatalogEntry {
  return {
    sessionId: summary.sessionId,
    startedAt: summary.startedAt,
    stoppedAt: summary.stoppedAt,
    durationMs: summary.durationMs,
    finalCount: summary.finalCount,
    issueCount: summary.issueCount,
    frameworkTitle: summary.frameworkTitle,
    displayTitle: customTitle ?? defaultCatalogTitle(summary.startedAt),
  };
}

export function replayFinals(events: readonly ReplayEvent[]): Array<{ id: string; text: string; startMs: number; endMs: number }> {
  const finals: Array<{ id: string; text: string; startMs: number; endMs: number }> = [];
  for (const event of events) {
    if (event.type !== "transcript_final") continue;
    const { id, text, startMs, endMs } = event.payload;
    if (typeof id !== "string" || typeof text !== "string" || typeof startMs !== "number" || !Number.isFinite(startMs) || typeof endMs !== "number" || !Number.isFinite(endMs)) continue;
    finals.push({ id, text, startMs, endMs });
  }
  return finals;
}

function redactEvent(event: ReplayEvent): ReplayEvent {
  return {
    ...event,
    payload: redactReplayValue(event.payload) as Record<string, unknown>,
  };
}

function chmodBestEffort(target: string, mode: number): void {
  try {
    chmodSync(target, mode);
  } catch {
    // Windows 上 chmod 可能无效，不因此让复盘失败。
  }
}

function isReplayEvent(value: unknown): value is ReplayEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<ReplayEvent>;
  return (
    event.schemaVersion === REPLAY_SCHEMA_VERSION &&
    typeof event.sessionId === "string" &&
    typeof event.recordedAt === "string" &&
    typeof event.type === "string" &&
    REPLAY_EVENT_TYPES.includes(event.type as ReplayEventType) &&
    !!event.payload &&
    typeof event.payload === "object"
  );
}

function isIssue(value: unknown): value is Issue {
  if (!value || typeof value !== "object") return false;
  const issue = value as Partial<Issue>;
  const evidence = issue.evidence;
  return (
    typeof issue.id === "string" &&
    typeof issue.sessionId === "string" &&
    typeof issue.fingerprint === "string" &&
    typeof issue.ruleId === "string" &&
    (issue.type === "content" || issue.type === "pace" || issue.type === "rhythm") &&
    (issue.severity === "info" || issue.severity === "warning" || issue.severity === "critical") &&
    (issue.status === "unread" || issue.status === "read") &&
    typeof issue.title === "string" &&
    typeof issue.frameworkRevision === "string" &&
    typeof issue.firstSeenAtMs === "number" && Number.isFinite(issue.firstSeenAtMs) &&
    typeof issue.lastSeenAtMs === "number" && Number.isFinite(issue.lastSeenAtMs) &&
    typeof issue.occurrenceCount === "number" && Number.isFinite(issue.occurrenceCount) &&
    !!evidence && typeof evidence === "object" &&
    typeof evidence.windowStartMs === "number" && Number.isFinite(evidence.windowStartMs) &&
    typeof evidence.windowEndMs === "number" && Number.isFinite(evidence.windowEndMs) &&
    Array.isArray(evidence.segmentIds) && evidence.segmentIds.every((id) => typeof id === "string") &&
    Array.isArray(evidence.frameworkItemIds) && evidence.frameworkItemIds.every((id) => typeof id === "string") &&
    Array.isArray(evidence.excerpts) && evidence.excerpts.every((excerpt) =>
      !!excerpt && typeof excerpt === "object" &&
      typeof excerpt.segmentId === "string" && typeof excerpt.text === "string" &&
      typeof excerpt.startMs === "number" && Number.isFinite(excerpt.startMs) &&
      typeof excerpt.endMs === "number" && Number.isFinite(excerpt.endMs)) &&
    !!evidence.metrics && typeof evidence.metrics === "object" && !Array.isArray(evidence.metrics) &&
    Object.values(evidence.metrics).every((metric) => ["string", "number", "boolean"].includes(typeof metric))
  );
}
