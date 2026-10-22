import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AudioFrame } from "../../src/shared/contracts/audio";
import type { AudioPump, AudioSink } from "../../src/main/audio/types";
import { FakeAsrAdapter } from "../../src/main/asr/FakeAsrAdapter";
import { SessionController } from "../../src/main/session/SessionController";
import { FrameworkStore, defaultFrameworkPath } from "../../src/main/framework/FrameworkStore";
import { applySettingsUpdate, resetAnalysisSettings } from "../../src/main/settings";
import { ISSUE_UTTERANCES } from "../../src/shared/fixtures/issueUtterances";
import { utteranceActive } from "../../src/shared/fixtures/demoUtterances";
import { defaultActionConfig } from "../../src/shared/contracts/actions";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionCards } from "../../src/renderer/features/actions/ActionCards";

afterEach(resetAnalysisSettings);
function setup() {
  applySettingsUpdate({ windowMs: 60_000, intervalMs: 15_000 });
  const root = mkdtempSync(path.join(os.tmpdir(), "dingbo-action-session-"));
  const frameworks = new FrameworkStore();
  const loaded = frameworks.loadFile(defaultFrameworkPath());
  if (!loaded.ok) throw new Error(loaded.message);
  const pump = new ScriptPump();
  const controller = new SessionController({
    frameworks, getReplayRoot: () => root,
    createPump: () => pump,
    createAsr: () => new FakeAsrAdapter({ loop: true, utterances: ISSUE_UTTERANCES }),
  });
  const config = defaultActionConfig(loaded.revision);
  config.enabled = true;
  config.rules.forEach(r => {
    r.enabled = true; r.stageId = "warmup"; r.requiredItemIds = ["ms-2"];
  });
  expect(controller.saveActionConfig(config).ok).toBe(true);
  return { controller, pump, config, frameworks };
}
describe("M6 integration with existing session scheduler", () => {
  it("uses real analysis coverage and current avoid hits, expires immediately on stage change, isolates restarts", async () => {
    const { controller, pump, config } = setup();
    const started = await controller.start({ audioSource: "simulated", asrId: "fake" });
    const sessionId = started.sessionId!;
    try {
      expect(controller.saveActionConfig(config).ok).toBe(false);
      emitUntil(pump, sessionId, 0, 60_000);
      const signals = controller.actionSnapshot().signals;
      expect(signals.map(s => s.kind)).toEqual(["stream.push_suggested"]);
      expect(signals[0].evidence.items[0].id).toBe("ms-2");
      expect(signals[0].evidence.excerpts.length).toBeGreaterThan(0);
      expect(controller.stageView()).not.toHaveProperty("actionSignals");
      const markup = renderToStaticMarkup(createElement(ActionCards, { signals, warning: null, onResolve: () => {} }));
      expect(markup).toContain("确认已处理");
      expect(markup).toContain("不代表推流或发券成功");
      const readOnly = renderToStaticMarkup(createElement(ActionCards, { signals, warning: null }));
      expect(readOnly).not.toContain("<button");
      controller.setStageId("pitch");
      expect(controller.actionSnapshot().signals[0].status).toBe("expired");
      controller.setStageId("warmup");
      emitUntil(pump, sessionId, 60_000, 75_000);
      expect(controller.actionSnapshot().signals).toHaveLength(1);
      await controller.stop();
      expect(controller.actionSnapshot().signals).toHaveLength(1);
      const replay = controller.currentReplay();
      expect(replay.ok).toBe(true);
      if (replay.ok) expect(replay.replay.actionHistory?.signals[0].status).toBe("expired");
      const historical = controller.loadReplayBySessionId(sessionId);
      if (historical.ok) expect(historical.replay.actionHistory?.signals).toHaveLength(1);
      const next = await controller.start({ audioSource: "simulated", asrId: "fake" });
      expect(controller.actionSnapshot().signals).toEqual([]);
      expect(controller.resolveAction({ sessionId, signalId: signals[0].id, status: "acknowledged" }).ok).toBe(false);
      emitUntil(pump, next.sessionId!, 0, 60_000);
      expect(controller.actionSnapshot().signals).toHaveLength(1);
    } finally { await controller.stop(); }
  });
  it("degraded or stopping sessions cannot acknowledge pending reminders", async () => {
    const { controller, pump } = setup();
    const started = await controller.start({ audioSource: "simulated", asrId: "fake" });
    try {
      emitUntil(pump, started.sessionId!, 0, 60_000);
      const signal = controller.actionSnapshot().signals[0];
      controller.notifyCaptureFailed(started.sessionId!, "test gap");
      expect(controller.snapshot().state).toBe("degraded");
      expect(controller.actionSnapshot().signals[0].status).toBe("expired");
      expect(controller.resolveAction({ sessionId: started.sessionId!, signalId: signal.id, status: "acknowledged" }).ok).toBe(false);
    } finally { await controller.stop(); }
  });
  it("a framework edit with unchanged ids migrates the old config instead of disabling it", async () => {
    const { controller, pump, frameworks } = setup();
    const previous = frameworks.current();
    if (!previous.ok) throw new Error();
    frameworks.loadObject({ ...previous.document, title: "new revision" });
    const started = await controller.start({ audioSource: "simulated", asrId: "fake" });
    try {
      emitUntil(pump, started.sessionId!, 0, 60_000);
      expect(controller.snapshot().state).toBe("running");
      expect(controller.actionSnapshot().enabled).toBe(true);
      expect(controller.actionSnapshot().warning).toBeNull();
    } finally { await controller.stop(); }
  });
  it("a framework whose stage ids changed disables the old config without blocking the session", async () => {
    const { controller, pump, frameworks } = setup();
    const previous = frameworks.current();
    if (!previous.ok) throw new Error();
    frameworks.loadObject({
      ...previous.document,
      stages: previous.document.stages?.map((stage) => ({ ...stage, id: `${stage.id}-v2` })),
    });
    const started = await controller.start({ audioSource: "simulated", asrId: "fake" });
    try {
      emitUntil(pump, started.sessionId!, 0, 60_000);
      expect(controller.snapshot().state).toBe("running");
      expect(controller.actionSnapshot()).toMatchObject({ enabled: false, signals: [] });
      expect(controller.actionSnapshot().warning).toContain("不匹配");
    } finally { await controller.stop(); }
  });
});

class ScriptPump implements AudioPump {
  readonly id = "simulated" as const;
  readonly monitorsLiveness = false;
  private sink: AudioSink | null = null;
  prepare() {}
  async start(_sessionId: string, sink: AudioSink) { this.sink = sink; }
  async stop() { this.sink = null; }
  emit(frame: AudioFrame) { this.sink?.onFrame(frame); }
  failCapture(message: string) { this.sink?.onCaptureError({ code: "capture_failed", message }); }
}
function emitUntil(pump: ScriptPump, sessionId: string, from: number, to: number) {
  for (let startMs = from; startMs < to; startMs += 20) {
    const speech = utteranceActive(startMs, ISSUE_UTTERANCES, true);
    pump.emit({
      sessionId, seq: startMs / 20, startMs, durationMs: 20, sampleRate: 16000,
      channels: 1, encoding: "pcm_s16le", samples: new Int16Array(320),
      rms: speech ? .2 : 0, speechProbability: speech ? .9 : 0,
    });
  }
}
