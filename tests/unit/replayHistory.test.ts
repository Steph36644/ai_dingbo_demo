import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Issue } from "../../src/shared/contracts/issue";
import { parseReplaySessionId } from "../../src/main/ipc/schemas";
import { SessionController } from "../../src/main/session/SessionController";
import {
  defaultCatalogTitle,
  listSessionReplays,
  loadSessionReplay,
  projectSessionReplay,
  readSessionReplayById,
  readSessionMeta,
  renameSessionReplay,
  replayIssues,
  REPLAY_SCHEMA_VERSION,
  SESSION_CATALOG_LIMIT,
  writeSessionReplay,
  type ReplayEvent,
} from "../../src/main/session/replay";
import { IssuesPanel } from "../../src/renderer/features/issues/IssuesPanel";
import { SessionCatalog } from "../../src/renderer/features/replay/SessionCatalog";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const SESSION = "11111111-1111-4111-8111-111111111111";

function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dingbo-catalog-"));
  dirs.push(dir);
  return dir;
}

function issue(input: {
  id: string;
  fingerprint: string;
  windowStartMs: number;
  windowEndMs: number;
  occurrenceCount: number;
  excerpt: string;
  firstSeenAtMs?: number;
  lastSeenAtMs?: number;
}): Issue {
  return {
    id: input.id,
    sessionId: SESSION,
    fingerprint: input.fingerprint,
    type: "pace",
    ruleId: "pace.too_fast",
    severity: "warning",
    title: "语速偏快",
    suggestion: "放慢语速",
    firstSeenAtMs: input.firstSeenAtMs ?? input.windowEndMs,
    lastSeenAtMs: input.lastSeenAtMs ?? input.windowEndMs,
    occurrenceCount: input.occurrenceCount,
    status: "unread",
    frameworkRevision: "rev-1",
    evidence: {
      windowStartMs: input.windowStartMs,
      windowEndMs: input.windowEndMs,
      segmentIds: ["s1"],
      frameworkItemIds: [],
      excerpts: [{ segmentId: "s1", text: input.excerpt, startMs: input.windowStartMs, endMs: input.windowEndMs }],
      metrics: { charsPerMinute: 320 },
    },
  };
}

function event(type: ReplayEvent["type"], payload: Record<string, unknown>, recordedAt: string, sessionId = SESSION): ReplayEvent {
  return { schemaVersion: REPLAY_SCHEMA_VERSION, sessionId, recordedAt, type, payload };
}

describe("回看历次证据投影", () => {
  it("同一指纹合成一张卡，并保留每次证据窗", () => {
    const first = issue({
      id: "issue-1",
      fingerprint: "pace:too_fast",
      windowStartMs: 0,
      windowEndMs: 300_000,
      occurrenceCount: 1,
      excerpt: "开场讲得快",
    });
    const second = issue({
      id: "issue-1",
      fingerprint: "pace:too_fast",
      windowStartMs: 1_616_000,
      windowEndMs: 1_916_000,
      occurrenceCount: 2,
      excerpt: "末段还是快",
      firstSeenAtMs: 300_000,
      lastSeenAtMs: 1_916_000,
    });
    const other = issue({
      id: "issue-2",
      fingerprint: "rhythm:low_density",
      windowStartMs: 1_560_000,
      windowEndMs: 1_860_000,
      occurrenceCount: 1,
      excerpt: "静音偏多",
    });
    const events = [
      event("session_started", {}, "2026-10-19T00:00:00.000Z"),
      event("issue_upserted", { issue: first }, "2026-10-19T00:05:00.000Z"),
      event("issue_upserted", { issue: second }, "2026-10-19T00:31:56.000Z"),
      event("issue_upserted", { issue: other }, "2026-10-19T00:31:00.000Z"),
      event("session_stopped", { audioClockMs: 1_916_000 }, "2026-10-19T00:32:00.000Z"),
    ];
    const pace = replayIssues(events).find((item) => item.fingerprint === "pace:too_fast");
    expect(pace?.id).toBe("issue-1");
    expect(pace?.occurrenceCount).toBe(2);
    expect(pace?.firstSeenAtMs).toBe(300_000);
    expect(pace?.lastSeenAtMs).toBe(1_916_000);
    expect(pace?.evidence.windowEndMs).toBe(1_916_000);
    expect(pace?.occurrences.map((item) => item.windowEndMs)).toEqual([300_000, 1_916_000]);
    expect(pace?.occurrences.map((item) => item.excerpts[0]?.text)).toEqual(["开场讲得快", "末段还是快"]);
    expect(pace?.occurrences.map((item) => item.occurrenceCount)).toEqual([1, 2]);
    expect(replayIssues(events)).toHaveLength(2);
    expect(events[1]?.payload.issue).not.toHaveProperty("occurrences");

    const root = tempRoot();
    const written = writeSessionReplay(root, SESSION, events);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const body = readFileSync(written.filePath, "utf8");
    expect(body).not.toContain("occurrences");
    const projected = projectSessionReplay(loadSessionReplay(written.filePath));
    expect(projected.issues.find((item) => item.fingerprint === "pace:too_fast")?.occurrences).toHaveLength(2);

    const html = renderToStaticMarkup(createElement(IssuesPanel, {
      issues: projected.issues,
      unreadCount: 0,
      qualityWarning: null,
      lastAnalysis: null,
      readOnly: true,
      defaultOpenId: "issue-1",
      onMarkRead: () => undefined,
      onMarkAllRead: () => undefined,
    }));
    expect(html).toContain("05:00–31:56");
    expect(html).toContain("末次证据 26:56–31:56");
    expect(html).toContain("历次证据");
    expect(html).toContain("开场讲得快");
    expect(html).toContain("末段还是快");
    expect(html).toContain("第 1 次");
    expect(html).toContain("第 2 次");
    expect(html).not.toContain("全部标为已读");
  });

  it("指纹相同但 id 不同时仍合成一张卡", () => {
    const events = [
      event("issue_upserted", { issue: issue({ id: "a", fingerprint: "pace:too_fast", windowStartMs: 0, windowEndMs: 300_000, occurrenceCount: 1, excerpt: "甲" }) }, "2026-10-19T00:05:00.000Z"),
      event("issue_upserted", { issue: issue({ id: "b", fingerprint: "pace:too_fast", windowStartMs: 60_000, windowEndMs: 360_000, occurrenceCount: 2, excerpt: "乙", firstSeenAtMs: 300_000, lastSeenAtMs: 360_000 }) }, "2026-10-19T00:06:00.000Z"),
    ];
    const issues = replayIssues(events);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.id).toBe("b");
    expect(issues[0]?.occurrences).toHaveLength(2);
  });
});

describe("场次目录扫描", () => {
  it("没有 sessions 目录时返回空列表", () => {
    const root = tempRoot();
    expect(listSessionReplays(root)).toEqual({ ok: true, sessions: [], truncated: false });
    const listed = JSON.stringify(listSessionReplays(root));
    expect(listed).not.toContain(root);
    expect(listed).not.toContain("session.jsonl");
  });

  it("只收录带 session.jsonl 的 UUID 目录，并拒绝裸路径", () => {
    const root = tempRoot();
    const older = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const newer = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const bare = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    expect(writeSessionReplay(root, older, boundary(older, "2026-10-19T01:00:00.000Z", "2026-10-19T01:10:00.000Z", "上一场")).ok).toBe(true);
    expect(writeSessionReplay(root, newer, boundary(newer, "2026-10-19T02:00:00.000Z", "2026-10-19T02:20:00.000Z", "这一场")).ok).toBe(true);
    const broken = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    mkdirSync(path.join(root, "sessions", bare), { recursive: true });
    mkdirSync(path.join(root, "sessions", broken), { recursive: true });
    mkdirSync(path.join(root, "sessions", "not-a-session"), { recursive: true });
    writeFileSync(path.join(root, "sessions", broken, "session.jsonl"), "{bad\n");
    writeFileSync(path.join(root, "sessions", "not-a-session", "session.jsonl"), "{}\n");
    writeFileSync(path.join(root, "sessions", older, "notes.txt"), "ignore");

    const listed = listSessionReplays(root);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.sessions.map((item) => item.sessionId)).toEqual([newer, older]);
    expect(listed.sessions[0]).toMatchObject({ frameworkTitle: "这一场", finalCount: 0, issueCount: 0 });
    const json = JSON.stringify(listed);
    expect(json).not.toContain(root);
    expect(json).not.toContain("session.jsonl");
    expect(json).not.toContain("notes.txt");

    const opened = readSessionReplayById(root, older);
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.replay.summary.frameworkTitle).toBe("上一场");
    expect(readSessionReplayById(root, bare)).toMatchObject({ ok: false, code: "unavailable" });
    expect(readSessionReplayById(root, "../etc/passwd")).toMatchObject({ ok: false, code: "invalid" });
    expect(readSessionReplayById(root, path.join(root, "sessions", older, "session.jsonl"))).toMatchObject({ ok: false, code: "invalid" });
    expect(JSON.stringify(readSessionReplayById(root, "../etc/passwd"))).not.toContain(root);
    expect(parseReplaySessionId("../etc/passwd")).toBeNull();
    expect(parseReplaySessionId(older)).toBe(older);

    const controller = new SessionController({
      getReplayRoot: () => root,
      createAsr: () => {
        throw new Error("目录测试不启动识别");
      },
      createPump: () => {
        throw new Error("目录测试不启动采音");
      },
    });
    const fromController = controller.listReplaySessions();
    expect(fromController.ok).toBe(true);
    if (fromController.ok) expect(fromController.sessions.map((item) => item.sessionId)).toEqual([newer, older]);
    expect(controller.loadReplayBySessionId(older).ok).toBe(true);
  });

  it("超过上限时只返回最近的场次", () => {
    const root = tempRoot();
    for (let index = 0; index < SESSION_CATALOG_LIMIT + 1; index += 1) {
      const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      const stopped = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
      expect(writeSessionReplay(root, id, boundary(id, "2026-01-01T00:00:00.000Z", stopped, "场")).ok).toBe(true);
    }
    const listed = listSessionReplays(root);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.truncated).toBe(true);
    expect(listed.sessions).toHaveLength(SESSION_CATALOG_LIMIT);
    const newest = `00000000-0000-4000-8000-${SESSION_CATALOG_LIMIT.toString(16).padStart(12, "0")}`;
    expect(listed.sessions[0]?.sessionId).toBe(newest);
    expect(listed.sessions.some((item) => item.sessionId.endsWith("000000000000"))).toBe(false);
  });

  it("未命名时按开播时间生成 displayTitle，与 framework title 解耦", () => {
    const root = tempRoot();
    expect(writeSessionReplay(root, SESSION, boundary(SESSION, "2026-10-19T08:00:00.000Z", "2026-10-19T08:30:00.000Z", "框架标题")).ok).toBe(true);
    const listed = listSessionReplays(root);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.sessions).toHaveLength(1);
    const entry = listed.sessions[0];
    expect(entry?.frameworkTitle).toBe("框架标题");
    expect(entry?.displayTitle).toBe(defaultCatalogTitle("2026-10-19T08:00:00.000Z"));
    expect(entry?.displayTitle).toMatch(/^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}$/);
    expect(entry?.displayTitle).not.toBe("框架标题");
  });

  it("rename 后目录返回自定义名；清空回到时间命名", () => {
    const root = tempRoot();
    expect(writeSessionReplay(root, SESSION, boundary(SESSION, "2026-10-19T08:00:00.000Z", "2026-10-19T08:30:00.000Z", "框架标题")).ok).toBe(true);

    const renamed = renameSessionReplay(root, SESSION, "双十一首播");
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.entry.displayTitle).toBe("双十一首播");
    expect(renamed.entry.frameworkTitle).toBe("框架标题");
    expect(readSessionMeta(root, SESSION)).toEqual({ customTitle: "双十一首播" });

    const listed = listSessionReplays(root);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.sessions[0]?.displayTitle).toBe("双十一首播");

    const cleared = renameSessionReplay(root, SESSION, "");
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.entry.displayTitle).toBe(defaultCatalogTitle("2026-10-19T08:00:00.000Z"));
    expect(readSessionMeta(root, SESSION)).toEqual({});
  });

  it("rename 拒绝非法 sessionId、过长标题、不存在的场次", () => {
    const root = tempRoot();
    expect(renameSessionReplay(root, "../etc/passwd", "x").ok).toBe(false);
    expect(renameSessionReplay(root, SESSION, "x").ok).toBe(false);
    expect(writeSessionReplay(root, SESSION, boundary(SESSION, "2026-10-19T08:00:00.000Z", "2026-10-19T08:30:00.000Z", "框架")).ok).toBe(true);
    const tooLong = renameSessionReplay(root, SESSION, "x".repeat(61));
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.code).toBe("invalid");
  });
});

describe("场次目录空态", () => {
  it("没有历史时给出短提示，列表项不带路径", () => {
    const empty = renderToStaticMarkup(createElement(SessionCatalog, {
      sessions: [],
      loading: false,
      error: null,
      truncated: false,
      activeSessionId: null,
      onSelect: () => undefined,
      onRename: async () => ({ ok: true }),
    }));
    expect(empty).toContain("还没有已落盘的历史场次");
    const filled = renderToStaticMarkup(createElement(SessionCatalog, {
      sessions: [{
        sessionId: SESSION,
        startedAt: "2026-10-19T00:00:00.000Z",
        stoppedAt: "2026-10-19T00:30:00.000Z",
        durationMs: 120_000,
        finalCount: 4,
        issueCount: 3,
        frameworkTitle: "示例商品话术框架",
        displayTitle: "2026/10/19 08:00",
      }],
      loading: false,
      error: null,
      truncated: false,
      activeSessionId: SESSION,
      onSelect: () => undefined,
      onRename: async () => ({ ok: true }),
    }));
    expect(filled).toContain("2026/10/19 08:00");
    expect(filled).toContain("示例商品话术框架");
    expect(filled).toContain("4 条字幕");
    expect(filled).toContain("3 条问题");
    expect(filled).not.toContain("session.jsonl");
    expect(filled).not.toContain("/sessions/");
  });
});

function boundary(sessionId: string, startedAt: string, stoppedAt: string, title: string): ReplayEvent[] {
  return [
    event("session_started", {}, startedAt, sessionId),
    event("framework_loaded", { title, revision: "rev" }, startedAt, sessionId),
    event("session_stopped", { audioClockMs: 60_000 }, stoppedAt, sessionId),
  ];
}
