import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ActionSignals, type ActionObservation } from "../../src/main/actions/ActionSignals";
import { ActionStorage } from "../../src/main/actions/storage";
import { defaultActionConfig } from "../../src/shared/contracts/actions";
import type { FrameworkLoadResult } from "../../src/shared/contracts/framework";
import { parseActionConfig } from "../../src/main/actions/schema";

const framework: FrameworkLoadResult = {
  ok: true, revision: "rev1", sourcePath: null, document: {
    pace: { min: 100, max: 300, unit: "chars_per_minute" },
    must_say: [{ id: "price", text: "今日机制", keywords: ["机制"] }],
    avoid: [], stages: [{ id: "sell", name: "促单" }, { id: "intro", name: "介绍" }],
  },
};
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "dingbo-actions-"));
  const storage = new ActionStorage(() => root);
  const actions = new ActionSignals(storage, () => 1_000_000);
  const config = defaultActionConfig("rev1");
  config.enabled = true;
  config.rules.forEach(r => { r.enabled = true; r.stageId = "sell"; r.requiredItemIds = ["price"]; });
  expect(actions.saveConfig(config, framework).ok).toBe(true);
  const sessionId = randomUUID();
  actions.begin(sessionId, framework);
  const input: ActionObservation = {
    sessionId, running: true, complete: true, finalFlush: false, qualityOk: true,
    stageId: "sell", stageLabel: "促单", windowStartMs: 0, windowEndMs: 60_000,
    coverage: [{ frameworkItemId: "price", text: "今日机制", covered: true, matchedSegmentIds: ["seg1"] }],
    segments: [{
      id: "seg1", sessionId, sourceResultId: "r1", startMs: 100, endMs: 1000,
      text: "今日机制", normalizedText: "今日机制", isFinal: true,
    }],
    avoidHit: false,
  };
  return { root, storage, actions, config, input, sessionId };
}
describe("M6.1 signal engine", () => {
  it("emits both kinds with evidence; continuous truth and duplicate windows never spam", () => {
    const { actions, input } = setup();
    actions.observe(input);
    expect(actions.snapshot().signals).toHaveLength(2);
    expect(actions.snapshot().signals[0].evidence.excerpts[0].text).toBe("今日机制");
    actions.observe(input);
    actions.observe({ ...input, windowEndMs: 300_000 });
    expect(actions.snapshot().signals).toHaveLength(2);
  });
  it("requires stage and cumulative coverage; coupon alone is blocked by current avoid hit", () => {
    const { actions, input } = setup();
    actions.observe({ ...input, stageId: "intro" });
    actions.observe({ ...input, windowEndMs: 75_000, coverage: [] });
    expect(actions.snapshot().signals).toEqual([]);
    actions.observe({ ...input, windowEndMs: 90_000, avoidHit: true });
    expect(actions.snapshot().signals.map(s => s.kind)).toEqual(["stream.push_suggested"]);
  });
  it.each([
    { qualityOk: false }, { complete: false }, { finalFlush: true }, { running: false },
  ])("invalidates pending and never emits on invalid input %j", patch => {
    const { actions, input } = setup();
    actions.observe(input);
    actions.observe({ ...input, windowEndMs: 90_000, ...patch });
    expect(actions.snapshot().signals.every(s => s.status === "expired")).toBe(true);
    expect(actions.snapshot().signals).toHaveLength(2);
  });
  it("fresh false-to-true edge and 180s hard cooldown are both required", () => {
    const { actions, input, config } = setup();
    expect(config.rules.every(rule => rule.cooldownSeconds === 180)).toBe(true);
    const first = input.windowEndMs;
    const cooldownMs = config.rules[0].cooldownSeconds * 1000;
    actions.observe(input);
    actions.observe({ ...input, windowEndMs: first + 15_000, stageId: "intro" });
    actions.observe({ ...input, windowEndMs: first + 30_000 });
    actions.observe({ ...input, windowEndMs: first + cooldownMs - 1_000, stageId: "intro" });
    actions.observe({ ...input, windowEndMs: first + cooldownMs - 500 });
    expect(actions.snapshot().signals).toHaveLength(2);
    actions.observe({ ...input, windowEndMs: first + cooldownMs, stageId: "intro" });
    actions.observe({ ...input, windowEndMs: first + cooldownMs + 1_000 });
    expect(actions.snapshot().signals).toHaveLength(4);
  });
  it("confirmation is idempotent, ignores cannot overwrite it; stale, expired and stopped requests fail", () => {
    const { actions, input, sessionId } = setup();
    actions.observe(input);
    const [first, second] = actions.snapshot().signals;
    const request = { sessionId, signalId: first.id, status: "acknowledged" as const };
    expect(actions.resolve(request, true).ok).toBe(true);
    expect(actions.resolve(request, true).ok).toBe(true);
    expect(actions.resolve({ ...request, status: "dismissed" }, true).ok).toBe(false);
    expect(actions.resolve({ ...request, sessionId: randomUUID() }, true).ok).toBe(false);
    expect(actions.resolve(request, false).ok).toBe(false);
    actions.invalidate("阶段变化");
    expect(actions.resolve({ ...request, signalId: second.id }, true).ok).toBe(false);
  });
  it("new sessions do not inherit signals, truth or cooldown", () => {
    const { actions, input } = setup();
    actions.observe(input);
    const next = randomUUID();
    actions.begin(next, framework);
    actions.observe(input);
    expect(actions.snapshot().signals).toEqual([]);
    actions.observe({ ...input, sessionId: next });
    expect(actions.snapshot().signals).toHaveLength(2);
  });
  it("default off and disabled configurations produce no signals", () => {
    const { actions, input } = setup();
    expect(actions.saveConfig(defaultActionConfig("rev1"), framework).ok).toBe(true);
    actions.begin(input.sessionId, framework);
    actions.observe(input);
    expect(actions.snapshot().signals).toEqual([]);
  });
  it("write failure keeps reminders and manual handling functional with visible warning", () => {
    const { actions, storage, input, sessionId } = setup();
    vi.spyOn(storage, "append").mockImplementation(() => { throw new Error("disk full"); });
    expect(() => actions.observe(input)).not.toThrow();
    expect(actions.snapshot().warning).toContain("写入失败");
    expect(actions.resolve({ sessionId, signalId: actions.snapshot().signals[0].id, status: "dismissed" }, true).ok).toBe(true);
  });
});
describe("M6 configuration and sidecar compatibility", () => {
  it("validates known IDs, cooldown, unknown fields and enabled rule requirements", () => {
    const { config } = setup();
    for (const raw of [
      { ...config, surprise: true },
      ...[["unknown"], ["price", "price"]].map(requiredItemIds => ({ ...config, rules: [{ ...config.rules[0], requiredItemIds }] })),
      ...[29, 3601, 30.1].map(cooldownSeconds => ({ ...config, rules: [{ ...config.rules[0], cooldownSeconds }] })),
      { ...config, rules: [{ ...config.rules[0], stageId: "missing" }] },
      { ...config, rules: [{ ...config.rules[0], stageIds: ["sell", "sell"] }] },
      { ...config, rules: [{ ...config.rules[0], stageIds: ["nope"] }] },
    ]) expect(parseActionConfig(raw, framework)).toBeNull();
    // 框架只改标题或关键词时 revision 会变，但规则引用的 id 没变，应迁移而不是判废
    const staleRevision = { ...config, frameworkRevision: "another-revision" };
    expect(parseActionConfig(staleRevision, framework)).toEqual({ ...config, frameworkRevision: framework.revision });
    const optionalStage = { ...config, rules: [{ ...config.rules[0], stageId: null, stageIds: [] }] };
    expect(parseActionConfig(optionalStage, framework)).toEqual(optionalStage);
    const multiStage = {
      ...config,
      rules: config.rules.map(rule => ({ ...rule, stageId: null, stageIds: ["sell", "intro"] })),
    };
    expect(parseActionConfig(multiStage, framework)).toEqual(multiStage);
    const cueOnly = { ...config, rules: [{ ...config.rules[0], requiredItemIds: [] }] };
    expect(parseActionConfig(cueOnly, framework)).toEqual(cueOnly);
    expect(parseActionConfig(config, framework)).toEqual(config);
  });
  it("frameworks without stages require unrestricted stage", () => {
    const { config } = setup();
    if (!framework.ok) throw new Error();
    const noStages = { ...framework, document: { ...framework.document, stages: undefined } };
    expect(parseActionConfig(config, noStages)).toBeNull();
    config.rules.forEach(r => { r.stageId = null; });
    expect(parseActionConfig(config, noStages)).toEqual(config);
  });
  it("missing, corrupt or mismatched config fails closed", () => {
    const { root, storage } = setup();
    expect(storage.loadConfig({ ok: false, code: "io_error", message: "bad" }).config.enabled).toBe(false);
    writeFileSync(path.join(root, "action-rules.v1.json"), "{broken");
    expect(storage.loadConfig(framework).warning).toContain("读取失败");
    const empty = new ActionStorage(() => path.join(root, "missing"));
    expect(empty.loadConfig(framework).config.enabled).toBe(false);
  });
  it("replays latest signal states without touching session.jsonl; old and corrupt sessions degrade independently", () => {
    const { root, actions, storage, input, sessionId } = setup();
    expect(storage.history(sessionId)).toEqual({ signals: [], warning: null });
    actions.observe(input);
    const main = path.join(root, "sessions", sessionId, "session.jsonl");
    writeFileSync(main, "M5 unchanged");
    actions.resolve({ sessionId, signalId: actions.snapshot().signals[0].id, status: "acknowledged" }, true);
    actions.invalidate("停止");
    expect(storage.history(sessionId).signals.map(s => s.status)).toEqual(["acknowledged", "expired"]);
    expect(readFileSync(main, "utf8")).toBe("M5 unchanged");
    writeFileSync(path.join(root, "sessions", sessionId, "action-signals.v1.jsonl"), "{bad");
    expect(storage.history(sessionId).warning).toContain("损坏");
    expect(storage.history("../escape").warning).toBeTruthy();
  });
});

function openTuned(options?: { stageIds?: string[]; required?: string[] }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "dingbo-cues-"));
  const actions = new ActionSignals(new ActionStorage(() => root), () => 1_000_000);
  const config = defaultActionConfig("rev1");
  config.enabled = true;
  config.rules.forEach(rule => {
    rule.enabled = true;
    rule.stageId = null;
    rule.stageIds = options?.stageIds ?? ["sell", "intro"];
    rule.requiredItemIds = options?.required ?? [];
  });
  expect(actions.saveConfig(config, framework).ok).toBe(true);
  const sessionId = randomUUID();
  actions.begin(sessionId, framework);
  return { actions, sessionId };
}
function say(
  actions: ActionSignals,
  sessionId: string,
  options: { end: number; text?: string; stageId?: string; avoid?: boolean; coverage?: boolean; segments?: ActionObservation["segments"] },
) {
  const text = options.text ?? "";
  const id = `seg-${options.end}`;
  const windowStartMs = Math.max(0, options.end - 60_000);
  actions.observe({
    sessionId,
    running: true,
    complete: true,
    finalFlush: false,
    qualityOk: true,
    stageId: options.stageId ?? "sell",
    stageLabel: "促单",
    windowStartMs,
    windowEndMs: options.end,
    coverage: options.coverage ? [{ frameworkItemId: "price", text: "今日机制", covered: true, matchedSegmentIds: [id] }] : [],
    segments: options.segments ?? (text ? [{
      id, sessionId, sourceResultId: "r1", startMs: options.end - 1_000, endMs: options.end - 1,
      text, normalizedText: text, isFinal: true,
    }] : []),
    avoidHit: options.avoid ?? false,
  });
}
describe("tuned push and coupon reminders", () => {
  it("does not let an uncovered ms-1 price point block a direct link", () => {
    const { actions, sessionId } = openTuned({ required: ["price"], stageIds: ["sell"] });
    say(actions, sessionId, { end: 60_000, text: "今天直播价" });
    expect(actions.snapshot().signals).toEqual([]);
    say(actions, sessionId, { end: 75_000, text: "八号链接拍这个" });
    expect(actions.snapshot().signals.map(signal => signal.kind)).toEqual(["stream.push_suggested"]);
    expect(actions.snapshot().signals[0].evidence.excerpts[0].text).toContain("八号链接");
    expect(actions.snapshot().signals[0].delivery).toBe("control_only");
  });

  it("fires direct links and coupons, and ignores weak words alone", () => {
    const { actions, sessionId } = openTuned();
    for (const [index, text] of ["第三代", "第8代", "下播了", "只要你喜欢", "便宜又划算", "最后一波", "核心卖点是胶原", "只要199块", "直播价"].entries()) {
      say(actions, sessionId, { end: 60_000 + index * 10_000, text });
    }
    expect(actions.snapshot().signals).toEqual([]);
    say(actions, sessionId, { end: 200_000, text: "胶原低至三九九" });
    expect(actions.snapshot().signals.map(signal => signal.kind)).toEqual(["stream.push_suggested"]);
    say(actions, sessionId, { end: 210_000, text: "现在发券" });
    expect(actions.snapshot().signals.map(signal => signal.kind)).toEqual(["stream.push_suggested", "coupon.issue_suggested"]);
    say(actions, sessionId, { end: 220_000, text: "倒计时开始" });
    expect(actions.snapshot().signals).toHaveLength(2);
    say(actions, sessionId, { end: 400_000, text: "倒计时开始" });
    expect(actions.snapshot().signals.filter(signal => signal.kind === "coupon.issue_suggested")).toHaveLength(2);
  });

  it("fires both kinds on 上链接就这一次, and avoid still blocks only the coupon", () => {
    const both = openTuned();
    say(both.actions, both.sessionId, { end: 60_000, text: "上链接就这一次" });
    expect(both.actions.snapshot().signals.map(signal => signal.kind).sort()).toEqual([
      "coupon.issue_suggested",
      "stream.push_suggested",
    ]);
    const blocked = openTuned();
    say(blocked.actions, blocked.sessionId, { end: 60_000, text: "马上发券", avoid: true });
    expect(blocked.actions.snapshot().signals).toEqual([]);
    say(blocked.actions, blocked.sessionId, { end: 75_000, text: "小黄车直接拍", avoid: true });
    expect(blocked.actions.snapshot().signals.map(signal => signal.kind)).toEqual(["stream.push_suggested"]);
  });

  it("treats pitch or close as enough, and does not lock the rule to one stage", () => {
    const { actions, sessionId } = openTuned();
    say(actions, sessionId, { end: 60_000, stageId: "intro", text: "一号链接" });
    expect(actions.snapshot().signals).toHaveLength(1);
    const next = randomUUID();
    actions.begin(next, framework);
    say(actions, next, { end: 60_000, stageId: "sell", text: "挂链接" });
    expect(actions.snapshot().signals).toHaveLength(1);
    const blocked = randomUUID();
    actions.begin(blocked, framework);
    say(actions, blocked, { end: 60_000, stageId: "warmup", text: "一号链接" });
    expect(actions.snapshot().signals).toEqual([]);

    const anyStage = openTuned({ stageIds: [] });
    say(anyStage.actions, anyStage.sessionId, { end: 60_000, stageId: "warmup", text: "直接拍" });
    expect(anyStage.actions.snapshot().signals).toHaveLength(1);

    const single = openTuned({ stageIds: ["sell"] });
    say(single.actions, single.sessionId, { end: 60_000, stageId: "intro", text: "上链接" });
    expect(single.actions.snapshot().signals).toEqual([]);
    say(single.actions, single.sessionId, { end: 75_000, stageId: "sell", text: "上链接" });
    expect(single.actions.snapshot().signals).toHaveLength(1);
  });

  it("keeps a 180s hard cooldown: same phrase does not refill, and a new phrase cannot break it early", () => {
    const { actions, sessionId } = openTuned();
    for (let index = 0; index < 24; index += 1) {
      say(actions, sessionId, { end: 60_000 + index * 15_000, text: "记住一号链接" });
    }
    expect(actions.snapshot().signals).toHaveLength(1);
    say(actions, sessionId, { end: 60_000 + 24 * 15_000, text: "换成八号链接" });
    expect(actions.snapshot().signals).toHaveLength(2);

    const early = openTuned();
    say(early.actions, early.sessionId, { end: 60_000, text: "一号链接" });
    say(early.actions, early.sessionId, { end: 239_000, text: "八号链接" });
    expect(early.actions.snapshot().signals).toHaveLength(1);
    say(early.actions, early.sessionId, { end: 240_000, text: "八号链接" });
    expect(early.actions.snapshot().signals).toHaveLength(2);

    const same = openTuned();
    say(same.actions, same.sessionId, { end: 60_000, text: "一号链接" });
    say(same.actions, same.sessionId, { end: 240_000, text: "一号链接" });
    say(same.actions, same.sessionId, { end: 420_000, text: "1号链接" });
    expect(same.actions.snapshot().signals).toHaveLength(1);

    const edge = openTuned();
    say(edge.actions, edge.sessionId, { end: 60_000, text: "一号链接" });
    say(edge.actions, edge.sessionId, { end: 200_000, text: "先聊两句" });
    say(edge.actions, edge.sessionId, { end: 230_000, text: "一号链接" });
    expect(edge.actions.snapshot().signals.filter(signal => signal.status === "pending")).toEqual([]);
    say(edge.actions, edge.sessionId, { end: 250_000, text: "先聊两句" });
    say(edge.actions, edge.sessionId, { end: 260_000, text: "一号链接" });
    expect(edge.actions.snapshot().signals.filter(signal => signal.status === "pending")).toHaveLength(1);
  });

  it("ignores a cue that has already slid out of the analysis window", () => {
    const { actions, sessionId } = openTuned();
    const stale = {
      id: "old", sessionId, sourceResultId: "r1", startMs: 1_000, endMs: 2_000,
      text: "一号链接", normalizedText: "一号链接", isFinal: true,
    };
    say(actions, sessionId, { end: 60_000, text: "一号链接" });
    expect(actions.snapshot().signals[0].status).toBe("pending");
    say(actions, sessionId, {
      end: 130_000,
      segments: [
        stale,
        {
          id: "idle", sessionId, sourceResultId: "r1", startMs: 80_000, endMs: 90_000,
          text: "大家好", normalizedText: "大家好", isFinal: true,
        },
      ],
    });
    expect(actions.snapshot().signals[0].status).toBe("expired");
  });
});
