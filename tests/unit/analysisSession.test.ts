import { afterEach, describe, expect, it } from "vitest";
import type { AudioFrame } from "../../src/shared/contracts/audio";
import type { AudioPump, AudioSink } from "../../src/main/audio/types";
import { FakeAsrAdapter } from "../../src/main/asr/FakeAsrAdapter";
import { SessionController } from "../../src/main/session/SessionController";
import { resetAnalysisSettings, applySettingsUpdate } from "../../src/main/settings";
import { ISSUE_UTTERANCES } from "../../src/shared/fixtures/issueUtterances";
import { utteranceActive } from "../../src/shared/fixtures/demoUtterances";

afterEach(() => {
  resetAnalysisSettings();
});

describe("Fake ASR 注入文稿", () => {
  it("问题样例在两个短窗口后给出触雷、长停顿、漏讲和部分勾选", async () => {
    applySettingsUpdate({ windowMs: 60_000, intervalMs: 15_000 });
    const pump = new ScriptPump();
    const controller = new SessionController({
      createAsr: () => new FakeAsrAdapter({ loop: true, utterances: ISSUE_UTTERANCES }),
      createPump: () => pump,
    });
    const started = await controller.start({ audioSource: "simulated", asrId: "fake", demoScript: "issues" });
    expect(started.state).toBe("running");
    const sessionId = started.sessionId ?? "";
    emitUntil(pump, sessionId, 0, 60_000);

    const first = controller.analysisSnapshot();
    expect(first.issues.map((issue) => issue.ruleId).sort()).toEqual(["content.avoid_hit", "rhythm.long_pause"]);
    const avoid = first.issues.find((issue) => issue.ruleId === "content.avoid_hit");
    expect(avoid?.severity).toBe("critical");
    expect(avoid?.evidence.frameworkItemIds).toEqual(["av-1"]);
    expect(avoid?.evidence.excerpts.some((item) => item.text.includes("一定能"))).toBe(true);
    expect(avoid?.suggestion).toContain("合规");
    expect(first.coverage.find((item) => item.frameworkItemId === "ms-2")?.covered).toBe(true);
    expect(first.coverage.find((item) => item.frameworkItemId === "ms-1")?.covered).toBe(false);
    expect(first.unreadCount).toBe(first.issues.filter((issue) => issue.status === "unread").length);

    emitUntil(pump, sessionId, 60_000, 75_000);
    const second = controller.analysisSnapshot();
    const missing = second.issues.find((issue) => issue.ruleId === "content.must_say_missing");
    expect(missing?.title).toBe("近窗有 2 个必讲点未覆盖");
    expect(missing?.evidence.frameworkItemIds).toEqual(["ms-1", "ms-3"]);
    expect(second.issues.filter((issue) => issue.type === "rhythm")).toHaveLength(1);
    expect(second.coverage.find((item) => item.frameworkItemId === "ms-2")?.covered).toBe(true);
    expect(second.unreadCount).toBe(3);

    controller.markIssueRead(avoid?.id ?? "");
    expect(controller.analysisSnapshot().unreadCount).toBe(2);
    expect(controller.analysisSnapshot().issues).toHaveLength(3);

    const stopped = await controller.stop();
    expect(stopped.state).toBe("completed");
    expect(controller.getTranscript().finals.some((item) => item.text.includes("直播间"))).toBe(true);
  });
});

class ScriptPump implements AudioPump {
  readonly id = "simulated" as const;
  readonly monitorsLiveness = false;
  private sink: AudioSink | null = null;

  prepare(): void {}

  async start(_sessionId: string, sink: AudioSink): Promise<void> {
    this.sink = sink;
  }

  async stop(): Promise<void> {
    this.sink = null;
  }

  emit(frame: AudioFrame): void {
    this.sink?.onFrame(frame);
  }
}

function emitUntil(pump: ScriptPump, sessionId: string, fromMs: number, toMs: number): void {
  for (let startMs = fromMs; startMs < toMs; startMs += 20) {
    const speech = utteranceActive(startMs, ISSUE_UTTERANCES, true);
    pump.emit({
      sessionId,
      seq: startMs / 20,
      startMs,
      durationMs: 20,
      sampleRate: 16000,
      channels: 1,
      encoding: "pcm_s16le",
      samples: new Int16Array(320),
      rms: speech ? 0.2 : 0,
      speechProbability: speech ? 0.9 : 0,
    });
  }
}
