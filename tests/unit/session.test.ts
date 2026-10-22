import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopbackAudioPump } from "../../src/main/audio/loopbackSource";
import { describeLoopback } from "../../src/main/audio/platformCapability";
import { SimulatedAudioPump } from "../../src/main/audio/simulatedSource";
import { probeWasapiBridge } from "../../src/main/audio/wasapiLoopback";
import type { AudioPump, AudioSink } from "../../src/main/audio/types";
import { FakeAsrAdapter } from "../../src/main/asr/FakeAsrAdapter";
import { FrameworkStore } from "../../src/main/framework/FrameworkStore";
import { SessionController } from "../../src/main/session/SessionController";
import { canAcceptStart, transition } from "../../src/main/session/machine";
import { applySettingsUpdate, currentSettings, resetAnalysisSettings } from "../../src/main/settings";
import { parseAudioChunk, parseSessionStart, parseSettingsUpdate } from "../../src/main/ipc/schemas";
import { RECONNECT } from "../../src/shared/config/defaults";
import type { AudioFrame } from "../../src/shared/contracts/audio";
import type { SessionState } from "../../src/shared/contracts/session";
import type { TranscriptDelta } from "../../src/shared/contracts/transcript";
import { DEMO_UTTERANCES } from "../../src/shared/fixtures/demoUtterances";

afterEach(() => {
  vi.useRealTimers();
  resetAnalysisSettings();
});

describe("会话状态机", () => {
  it("走完 idle → preparing → running → stopping → completed", () => {
    let state: SessionState = "idle";
    state = transition(state, "START");
    state = transition(state, "READY");
    state = transition(state, "DEGRADE");
    state = transition(state, "RECOVER");
    state = transition(state, "STOP");
    state = transition(state, "STOPPED_OK");
    expect(state).toBe("completed");
    expect(canAcceptStart("running")).toBe(false);
    expect(canAcceptStart("completed")).toBe(true);
  });

  it("拒绝不存在的跳转", () => {
    expect(() => transition("idle", "STOP")).toThrow(/illegal/);
    expect(() => transition("running", "READY")).toThrow(/illegal/);
  });
});

describe("设置与 IPC 校验", () => {
  it("窗口和间隔保持 SDD 默认值，改动要落在边界内", () => {
    const settings = currentSettings();
    expect(settings.windowMs).toBe(300_000);
    expect(settings.intervalMs).toBe(60_000);
    expect(settings.windowEditable).toBe(true);
    expect(settings.intervalEditable).toBe(true);
    expect(settings.streamAudible).toBe(false);
    expect(settings.reconnect.backoffMs).toEqual(RECONNECT.backoffMs);
    expect(settings.reconnect.autoReconnect).toBe(true);
    expect(applySettingsUpdate({ windowMs: 10_000, intervalMs: 60_000 }).ok).toBe(false);
    expect(currentSettings().windowMs).toBe(300_000);
    expect(applySettingsUpdate({ windowMs: 120_000, intervalMs: 30_000 })).toMatchObject({ ok: true });
    expect(currentSettings()).toMatchObject({ windowMs: 120_000, intervalMs: 30_000 });
    expect(parseSettingsUpdate({ windowMs: 60_000, intervalMs: 60_000, extra: true })).toBeNull();
  });

  it("直播流外放默认关闭，可单独保存，不改窗口和间隔", () => {
    expect(currentSettings().streamAudible).toBe(false);
    expect(applySettingsUpdate({ streamAudible: true })).toMatchObject({
      ok: true,
      settings: { streamAudible: true, windowMs: 300_000, intervalMs: 60_000 },
    });
    expect(applySettingsUpdate({ streamAudible: "on" }).ok).toBe(false);
    expect(currentSettings().streamAudible).toBe(true);
    expect(applySettingsUpdate({ streamAudible: false })).toMatchObject({
      ok: true,
      settings: { streamAudible: false },
    });
    expect(parseSettingsUpdate({ streamAudible: false })).toEqual({ streamAudible: false });
    expect(parseSettingsUpdate({ streamAudible: false, extra: true })).toBeNull();
    expect(parseSettingsUpdate({ windowMs: 120_000, intervalMs: 30_000, streamAudible: true })).toEqual({
      windowMs: 120_000,
      intervalMs: 30_000,
      streamAudible: true,
    });
  });

  it("拒绝不合法的开始参数和音频块", () => {
    expect(parseSessionStart({ audioSource: "mic", asrId: "fake" })).toBeNull();
    expect(parseSessionStart({ audioSource: "simulated", asrId: "fake" })).toEqual({
      audioSource: "simulated",
      asrId: "fake",
    });
    expect(parseSessionStart({ audioSource: "stream", asrId: "fake" })).toBeNull();
    expect(parseSessionStart({ audioSource: "stream", asrId: "fake", streamUrl: "https://www.douyin.com/1" })).toBeNull();
    expect(
      parseSessionStart({ audioSource: "stream", asrId: "fake", streamUrl: "live.douyin.com/295178185857?from=web" }),
    ).toEqual({
      audioSource: "stream",
      asrId: "fake",
      streamUrl: "https://live.douyin.com/295178185857",
    });
    expect(
      parseSessionStart({ audioSource: "simulated", asrId: "fake", streamUrl: "https://live.douyin.com/295178185857" }),
    ).toBeNull();
    expect(parseAudioChunk({ sessionId: "s", sampleRate: 16_000, channels: 1, capturedAtMs: 0, samples: [] })).toBeNull();
    const parsed = parseAudioChunk({
      sessionId: "s",
      sampleRate: 16_000,
      channels: 1,
      capturedAtMs: 0,
      samples: [0.1, -0.2],
    });
    expect(parsed?.samples).toBeInstanceOf(Float32Array);
  });
});

describe("SessionController", () => {
  it("框架校验失败时不开始盯播，也不创建音频泵", async () => {
    const frameworks = new FrameworkStore();
    frameworks.loadObject({ title: "坏框架" });
    let pumps = 0;
    const controller = new SessionController({
      frameworks,
      createAsr: () => new FakeAsrAdapter({ loop: false }),
      createPump: () => {
        pumps += 1;
        return new SimulatedAudioPump({ loop: false });
      },
    });
    const snapshot = await controller.start({ audioSource: "simulated", asrId: "fake" });
    expect(snapshot.state).toBe("error");
    expect(snapshot.error?.code).toBe("framework_invalid");
    expect(snapshot.error?.message).toContain("话术框架无效");
    expect(pumps).toBe(0);
  });

  it("模拟音频加 Fake ASR 能滚出确定字幕，重复开始不会另开会话", async () => {
    vi.useFakeTimers();
    const deltas: TranscriptDelta[] = [];
    const controller = new SessionController({
      createAsr: () => new FakeAsrAdapter({ loop: false, utterances: DEMO_UTTERANCES }),
      createPump: () => new SimulatedAudioPump({ loop: false, utterances: DEMO_UTTERANCES }),
    });
    controller.onTranscript((delta) => deltas.push(delta));
    const started = await controller.start({ audioSource: "simulated", asrId: "fake" });
    expect(started.state).toBe("running");
    expect(started.guidance).toContain("不是系统环回");
    await vi.advanceTimersByTimeAsync(1_900);
    expect(controller.getTranscript().finals.some((segment) => segment.text.includes("直播间"))).toBe(true);
    expect(deltas.some((delta) => delta.kind === "partial")).toBe(true);

    const again = await controller.start({ audioSource: "simulated", asrId: "fake" });
    expect(again.sessionId).toBe(started.sessionId);
    expect(again.state).toBe("running");

    const stopped = await controller.stop();
    expect(stopped.state).toBe("completed");
    expect(controller.getTranscript().finals.length).toBeGreaterThan(0);
  });

  it("环回不可用时进入 error，并且没有伪造字幕", async () => {
    const deltas: TranscriptDelta[] = [];
    const controller = new SessionController({
      createAsr: () => new FakeAsrAdapter({ loop: false, utterances: DEMO_UTTERANCES }),
      createPump: () =>
        new LoopbackAudioPump({
          assess: () => describeLoopback({ platform: "linux", screens: [], wasapi: probeWasapiBridge(false) }),
          requestCapture: () => undefined,
          timeoutMs: 200,
        }),
    });
    controller.onTranscript((delta) => deltas.push(delta));
    const snapshot = await controller.start({ audioSource: "loopback", asrId: "fake" });
    expect(snapshot.state).toBe("error");
    expect(snapshot.error?.code).toBe("loopback_unavailable");
    expect(snapshot.error?.message).toContain("模拟音频");
    expect(deltas.some((delta) => delta.kind === "final" || delta.kind === "partial")).toBe(false);
  });

  it("环回超时不算盯播成功", async () => {
    vi.useFakeTimers();
    let requested = false;
    const controller = new SessionController({
      createAsr: () => new FakeAsrAdapter({ loop: false }),
      createPump: () =>
        new LoopbackAudioPump({
          assess: () =>
            describeLoopback({
              platform: "win32",
              screens: [{ id: "screen:0", name: "主屏幕" }],
              wasapi: probeWasapiBridge(false),
            }),
          requestCapture: () => {
            requested = true;
          },
          timeoutMs: 1_000,
        }),
    });
    const pending = controller.start({ audioSource: "loopback", asrId: "fake" });
    await vi.advanceTimersByTimeAsync(1_000);
    const snapshot = await pending;
    expect(requested).toBe(true);
    expect(snapshot.state).toBe("error");
    expect(snapshot.error?.code).toBe("capture_no_frames");
  });

  it("运行中连续 3 秒没有帧会降级，新帧可以恢复", async () => {
    vi.useFakeTimers();
    const pump = new ManualPump();
    const controller = new SessionController({
      createAsr: () => new FakeAsrAdapter({ loop: false }),
      createPump: () => pump,
    });
    await controller.start({ audioSource: "loopback", asrId: "fake" });
    expect(controller.snapshot().state).toBe("running");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(controller.snapshot().state).toBe("degraded");
    expect(controller.snapshot().degradedReason).toContain("3");
    pump.emit(makeFrame(40));
    expect(controller.snapshot().state).toBe("running");
    await controller.stop();
  });
});

class ManualPump implements AudioPump {
  readonly id = "loopback" as const;
  readonly monitorsLiveness = true;
  private sink: AudioSink | null = null;

  prepare(): void {}

  async start(_sessionId: string, sink: AudioSink): Promise<void> {
    this.sink = sink;
    sink.onFrame(makeFrame(0));
  }

  async stop(): Promise<void> {
    this.sink = null;
  }

  emit(frame: AudioFrame): void {
    this.sink?.onFrame(frame);
  }
}

function makeFrame(startMs: number): AudioFrame {
  return {
    sessionId: "ignored",
    seq: startMs / 20,
    startMs,
    durationMs: 20,
    sampleRate: 16000,
    channels: 1,
    encoding: "pcm_s16le",
    samples: new Int16Array(320),
    rms: 0.1,
    speechProbability: 0.9,
  };
}
