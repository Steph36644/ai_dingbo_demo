import { describe, expect, it } from "vitest";
import type { Issue } from "../../src/shared/contracts/issue";
import type { SessionSnapshot } from "../../src/shared/contracts/session";
import { SessionProjection } from "../../src/main/session/SessionProjection";

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: "s1",
    state: "running",
    audioSource: "simulated",
    asrId: "fake",
    error: null,
    guidance: null,
    phaseDetail: null,
    startedAtIso: "2026-10-19T00:00:00.000Z",
    audioClockMs: 0,
    degradedReason: null,
    stopWarning: null,
    persistence: "memory",
    persistenceNote: "",
    replayFile: null,
    reconnectAttempt: null,
    reconnectMaxAttempts: null,
    frameworkTitle: null,
    frameworkRevision: null,
    unreadCount: 0,
    qualityWarning: null,
    ...overrides,
  };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "i1",
    sessionId: "s1",
    fingerprint: "f1",
    type: "content",
    ruleId: "content.avoid_hit",
    severity: "warning",
    title: "t",
    suggestion: "s",
    firstSeenAtMs: 0,
    lastSeenAtMs: 100,
    occurrenceCount: 1,
    status: "unread",
    frameworkRevision: "r",
    evidence: {
      windowStartMs: 0,
      windowEndMs: 60_000,
      segmentIds: [],
      excerpts: [],
      frameworkItemIds: [],
      metrics: {},
    },
    ...overrides,
  };
}

describe("SessionProjection", () => {
  it("未开播时 stageLabel 为「未开播」", () => {
    const projection = new SessionProjection();
    const view = projection.stageView({ session: session({ sessionId: null, state: "idle" }), issues: [], stages: [] });
    expect(view.stageLabel).toBe("未开播");
    expect(view.health).toBe("idle");
  });

  it("无 stages 时显示「直播中」，running 时 health 为 ok", () => {
    const projection = new SessionProjection();
    const view = projection.stageView({ session: session(), issues: [], stages: undefined });
    expect(view.stageLabel).toBe("直播中");
    expect(view.health).toBe("ok");
  });

  it("默认取 stages 第一项", () => {
    const projection = new SessionProjection();
    const view = projection.stageView({
      session: session(),
      issues: [],
      stages: [{ id: "warmup", name: "开场" }, { id: "pitch", name: "讲品" }],
    });
    expect(view.stageLabel).toBe("开场");
  });

  it("setStageId 后显示对应阶段名", () => {
    const projection = new SessionProjection();
    projection.setStageId("pitch");
    const view = projection.stageView({
      session: session(),
      issues: [],
      stages: [{ id: "warmup", name: "开场" }, { id: "pitch", name: "讲品" }],
    });
    expect(view.stageLabel).toBe("讲品");
  });

  it("critical 优先级高于 warning，同档取 lastSeenAtMs 更新", () => {
    const projection = new SessionProjection();
    const view = projection.stageView({
      session: session(),
      issues: [
        issue({ id: "w1", severity: "warning", lastSeenAtMs: 200, suggestion: "warning-200" }),
        issue({ id: "c1", severity: "critical", lastSeenAtMs: 100, suggestion: "critical-100" }),
        issue({ id: "w2", severity: "warning", lastSeenAtMs: 300, suggestion: "warning-300" }),
      ],
      stages: undefined,
    });
    expect(view.suggestion).toBe("critical-100");
  });

  it("pin 盖过自动选择", () => {
    const projection = new SessionProjection();
    projection.setPinnedIssueId("w1");
    const view = projection.stageView({
      session: session(),
      issues: [
        issue({ id: "c1", severity: "critical", suggestion: "critical" }),
        issue({ id: "w1", severity: "warning", suggestion: "pinned" }),
      ],
      stages: undefined,
    });
    expect(view.suggestion).toBe("pinned");
  });

  it("dismiss 让 Stage 跳过该条，不标已读", () => {
    const projection = new SessionProjection();
    projection.dismissIssue("c1");
    const view = projection.stageView({
      session: session(),
      issues: [
        issue({ id: "c1", severity: "critical", suggestion: "critical" }),
        issue({ id: "w1", severity: "warning", suggestion: "warning" }),
      ],
      stages: undefined,
    });
    expect(view.suggestion).toBe("warning");
    expect(view.unreadCount).toBe(2);
  });

  it("degraded 时 health 为 degraded", () => {
    const projection = new SessionProjection();
    const view = projection.stageView({
      session: session({ state: "degraded" }),
      issues: [],
      stages: undefined,
    });
    expect(view.health).toBe("degraded");
  });

  it("error 时 health 为 error", () => {
    const projection = new SessionProjection();
    const view = projection.stageView({
      session: session({ state: "error" }),
      issues: [],
      stages: undefined,
    });
    expect(view.health).toBe("error");
  });

  it("无未读且无 pin 时 suggestion 为 null", () => {
    const projection = new SessionProjection();
    const view = projection.stageView({
      session: session(),
      issues: [issue({ status: "read" })],
      stages: undefined,
    });
    expect(view.suggestion).toBeNull();
  });

  it("productNote  trim 后为空则存 null", () => {
    const projection = new SessionProjection();
    projection.setProductNote("  ");
    const current = projection.current({ session: session(), issues: [], stages: undefined });
    expect(current.productNote).toBeNull();
    projection.setProductNote("  今晚主推面霜  ");
    expect(projection.current({ session: session(), issues: [], stages: undefined }).productNote).toBe("今晚主推面霜");
  });

  it("忽略已钉住的问题会自动解钉，改由其他未读问题接管", () => {
    const projection = new SessionProjection();
    projection.setPinnedIssueId("w1");
    projection.dismissIssue("w1");
    const view = projection.stageView({
      session: session(),
      issues: [
        issue({ id: "c1", severity: "critical", suggestion: "critical" }),
        issue({ id: "w1", severity: "warning", suggestion: "pinned" }),
      ],
      stages: undefined,
    });
    expect(view.suggestion).toBe("critical");
    expect(projection.current({ session: session(), issues: [], stages: undefined }).pinnedIssueId).toBeNull();
  });

  it("pinnedIssueId 只进中控快照，不进 StageView", () => {
    const projection = new SessionProjection();
    projection.setPinnedIssueId("w1");
    const snapshot = projection.current({
      session: session(),
      issues: [issue({ id: "w1" })],
      stages: undefined,
    });
    expect(snapshot.pinnedIssueId).toBe("w1");
    expect(projection.stageView({ session: session(), issues: [issue({ id: "w1" })], stages: undefined })).not.toHaveProperty(
      "pinnedIssueId",
    );
  });
});
