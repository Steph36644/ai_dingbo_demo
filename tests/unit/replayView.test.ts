import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readCurrentSessionReplay, REPLAY_SCHEMA_VERSION, type ReplayEvent } from "../../src/main/session/replay";
import { presentationForReplay } from "../../src/renderer/features/replay/replayPresentation";
import { ReplayView } from "../../src/renderer/features/replay/ReplayView";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fixture(events: unknown[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dingbo-replay-read-"));
  dirs.push(dir);
  const file = path.join(dir, "session.jsonl");
  writeFileSync(file, events.map((event) => typeof event === "string" ? event : JSON.stringify(event)).join("\n"));
  return file;
}

function event(type: string, sessionId = "11111111-1111-4111-8111-111111111111"): ReplayEvent {
  return { schemaVersion: REPLAY_SCHEMA_VERSION, sessionId, recordedAt: "2026-10-19T00:00:00.000Z", type: type as ReplayEvent["type"], payload: {} };
}

describe("当前场 JSONL 安全重读", () => {
  it("只读当前已结束场，投影问题、字幕和摘要，不写回文件", () => {
    const file = fixture([
      event("session_started"),
      { ...event("framework_loaded"), payload: { title: "测试框架", revision: "abc" } },
      { ...event("transcript_final"), payload: { id: "f1", text: "第一句。", startMs: 100, endMs: 500 } },
      { ...event("transcript_final"), payload: { id: "f2", text: "第二句。", startMs: 50, endMs: 90 } },
      event("session_stopped"),
    ]);
    const result = readCurrentSessionReplay(file, true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.replay.finals.map((item) => item.id)).toEqual(["f2", "f1"]);
      expect(result.replay.summary.frameworkTitle).toBe("测试框架");
      const html = renderToStaticMarkup(createElement(ReplayView, { replay: result.replay }));
      expect(html).toContain("JSONL 只读回看");
      expect(html).toContain("第一句。");
      expect(html).not.toContain("全部标为已读");
      const punctuated = renderToStaticMarkup(createElement(ReplayView, {
        replay: {
          ...result.replay,
          finals: [
            { id: "f2", text: "上一句没有标点", startMs: 50, endMs: 90 },
            { id: "f1", text: "下一句也没有", startMs: 100, endMs: 500 },
          ],
        },
        presentation: { sourceIds: ["f2", "f1"], text: "上一句没有标点。下一句也没有", mode: "offline" },
      }));
      expect(punctuated).toContain("上一句没有标点。");
      expect(punctuated).toContain("下一句也没有");
      expect(punctuated).not.toContain("上一句没有标点。下一句也没有");

      const overlay = { sourceIds: ["f2", "f1"], text: "上一句没有标点。下一句也没有", mode: "offline" as const };
      const currentId = result.replay.summary.sessionId;
      expect(presentationForReplay(null, currentId, overlay)).toBe(overlay);
      const historicalPresentation = presentationForReplay("22222222-2222-4222-8222-222222222222", currentId, overlay);
      const sameSessionFromCatalog = presentationForReplay(currentId, currentId, overlay);
      expect(historicalPresentation).toBeNull();
      expect(sameSessionFromCatalog).toBeNull();
      const historical = renderToStaticMarkup(createElement(ReplayView, {
        replay: {
          ...result.replay,
          summary: { ...result.replay.summary, sessionId: "22222222-2222-4222-8222-222222222222" },
          finals: [
            { id: "f2", text: "上一句没有标点", startMs: 50, endMs: 90 },
            { id: "f1", text: "下一句也没有", startMs: 100, endMs: 500 },
          ],
        },
        presentation: historicalPresentation,
      }));
      expect(historical).toContain("上一句没有标点");
      expect(historical).not.toContain("上一句没有标点。");
      expect(historical).not.toContain("下一句也没有。");
    }
    expect(readCurrentSessionReplay(file, false)).toMatchObject({ ok: false, code: "unavailable" });
    expect(readCurrentSessionReplay(null, true)).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("拒绝坏 JSON、混合 sessionId、错误边界和缺失文件", () => {
    expect(readCurrentSessionReplay(fixture(["{bad"]), true)).toMatchObject({ ok: false, code: "invalid" });
    expect(readCurrentSessionReplay(fixture([
      event("session_started"),
      event("session_stopped", "22222222-2222-4222-8222-222222222222"),
    ]), true)).toMatchObject({ ok: false, code: "invalid" });
    expect(readCurrentSessionReplay(fixture([event("session_started")]), true)).toMatchObject({ ok: false, code: "invalid" });
    expect(readCurrentSessionReplay(fixture([{ ...event("session_started"), schemaVersion: 99 }, event("session_stopped")]), true)).toMatchObject({ ok: false, code: "invalid" });
    expect(readCurrentSessionReplay(path.join(tmpdir(), "missing-dingbo-replay.jsonl"), true)).toMatchObject({ ok: false, code: "read_failed" });
  });

  it("超过读取上限时返回错误而不是继续解析", () => {
    const huge = fixture([`"${"x".repeat(64 * 1024 * 1024 + 1)}"`]);
    expect(readCurrentSessionReplay(huge, true)).toMatchObject({ ok: false, code: "invalid" });
  });
});
