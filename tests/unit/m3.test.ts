import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowScheduler } from "../../src/main/analysis/WindowScheduler";
import type { AudioFrame } from "../../src/shared/contracts/audio";
import type { AudioPump, AudioSink } from "../../src/main/audio/types";
import { FakeAsrAdapter } from "../../src/main/asr/FakeAsrAdapter";
import type { AsrStartConfig } from "../../src/shared/contracts/asr";
import { SessionController } from "../../src/main/session/SessionController";
import { loadSessionReplay, replayFinals, replayIssues } from "../../src/main/session/replay";
import { logEvent } from "../../src/main/security/log";
import { noteSensitive, resetSensitiveValues } from "../../src/main/security/redact";
import { MemorySecretBackend, SecretStore } from "../../src/main/security/SecretStore";
import { XfyunServiceError } from "../../src/main/asr/xfyunProtocol";
import { applySettingsUpdate, configureSettingsPersistence, currentSettings, resetAnalysisSettings } from "../../src/main/settings";
import { parseSecretSet, parseSessionStart, parseSettingsUpdate, parseXfyunSecretSet } from "../../src/main/ipc/schemas";
import { transition } from "../../src/main/session/machine";
import { COVERAGE_DISTINCTION, coverageEmptyKind, coverageEmptyMessage } from "../../src/shared/issues/coverageCopy";
import { RULE_SUGGESTIONS, cardSuggestion } from "../../src/shared/issues/suggestions";
import { DEMO_UTTERANCES } from "../../src/shared/fixtures/demoUtterances";
import type { AudioFrame as Frame } from "../../src/shared/contracts/audio";

const SECRET = "sk-test-cloud-asr-key-not-for-git";

afterEach(() => {
  vi.useRealTimers();
  resetAnalysisSettings();
  resetSensitiveValues();
});

describe("建议动作", () => {
  it("卡片优先用规则给出的 suggestion，缺失时回退到模板", () => {
    expect(cardSuggestion({ ruleId: "pace.too_fast", suggestion: "  放慢  " })).toBe("放慢");
    expect(cardSuggestion({ ruleId: "pace.too_fast" })).toBe(RULE_SUGGESTIONS.paceFast);
    expect(cardSuggestion({ ruleId: "content.avoid_hit" })).toBe(RULE_SUGGESTIONS.avoid);
    expect(cardSuggestion({ ruleId: "content.must_say_missing" })).toBe(RULE_SUGGESTIONS.mustSayFallback);
    expect(cardSuggestion({ ruleId: "rhythm.no_pause" })).toBe(RULE_SUGGESTIONS.noPause);
    expect(cardSuggestion({ ruleId: "unknown" })).toContain("口播");
  });
});

describe("本场累计文案", () => {
  it("空态和近窗漏讲分开说", () => {
    expect(COVERAGE_DISTINCTION).toContain("本场累计");
    expect(COVERAGE_DISTINCTION).toContain("近窗漏讲");
    expect(coverageEmptyKind({ frameworkReady: null, mustSayCount: 0, itemCount: 0 })).toBe("loading");
    expect(coverageEmptyKind({ frameworkReady: false, mustSayCount: 0, itemCount: 0 })).toBe("invalid");
    expect(coverageEmptyKind({ frameworkReady: true, mustSayCount: 0, itemCount: 0 })).toBe("no-must-say");
    expect(coverageEmptyKind({ frameworkReady: true, mustSayCount: 3, itemCount: 0 })).toBe("not-started");
    expect(coverageEmptyKind({ frameworkReady: true, mustSayCount: 3, itemCount: 3 })).toBeNull();
    expect(coverageEmptyMessage("not-started")).toContain("整场累计");
    expect(coverageEmptyMessage("not-started")).toContain("近窗漏讲");
    expect(coverageEmptyMessage("no-must-say")).toContain("must_say");
  });
});

describe("设置落盘", () => {
  it("窗口和间隔写入 JSON，重启后仍在，越界和密钥字段会被拒绝", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dingbo-settings-"));
    try {
      configureSettingsPersistence(dir);
      expect(applySettingsUpdate({ windowMs: 10_000, intervalMs: 60_000 }).ok).toBe(false);
      expect(currentSettings().windowMs).toBe(300_000);
      expect(applySettingsUpdate({ windowMs: 120_000, intervalMs: 30_000, apiKey: SECRET }).ok).toBe(false);
      const saved = applySettingsUpdate({ windowMs: 120_000, intervalMs: 30_000 });
      expect(saved.ok).toBe(true);
      expect(saved.settings.persisted).toBe(true);
      const file = path.join(dir, "settings.json");
      const text = readFileSync(file, "utf8");
      expect(text).not.toContain(SECRET);
      expect(JSON.parse(text)).toEqual({ schemaVersion: 1, windowMs: 120_000, intervalMs: 30_000, streamAudible: false });
      if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

      resetAnalysisSettings();
      configureSettingsPersistence(dir);
      expect(currentSettings()).toMatchObject({ windowMs: 120_000, intervalMs: 30_000 });

      writeFileSync(file, JSON.stringify({ schemaVersion: 1, windowMs: 60_000, intervalMs: 15_000, apiKey: SECRET }));
      resetAnalysisSettings();
      configureSettingsPersistence(dir);
      expect(currentSettings().windowMs).toBe(300_000);
      expect(JSON.stringify(currentSettings())).not.toContain(SECRET);
      expect(parseSettingsUpdate({ windowMs: 60_000, intervalMs: 60_000, key: SECRET })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("直播流外放写入 settings.json，旧文件没有该字段时默认关闭", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dingbo-settings-audible-"));
    try {
      configureSettingsPersistence(dir);
      expect(currentSettings().streamAudible).toBe(false);
      const saved = applySettingsUpdate({ streamAudible: true });
      expect(saved).toMatchObject({ ok: true, message: "已打开直播流外放。", settings: { streamAudible: true, windowMs: 300_000 } });
      const file = path.join(dir, "settings.json");
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ schemaVersion: 1, streamAudible: true });

      resetAnalysisSettings();
      configureSettingsPersistence(dir);
      expect(currentSettings().streamAudible).toBe(true);

      writeFileSync(file, JSON.stringify({ schemaVersion: 1, windowMs: 180_000, intervalMs: 45_000 }));
      resetAnalysisSettings();
      configureSettingsPersistence(dir);
      expect(currentSettings()).toMatchObject({ windowMs: 180_000, intervalMs: 45_000, streamAudible: false });

      const closed = applySettingsUpdate({ windowMs: 180_000, intervalMs: 45_000, streamAudible: false });
      expect(closed).toMatchObject({ ok: true, message: "已保存窗口、间隔和直播流外放。" });
      expect(JSON.parse(readFileSync(file, "utf8")).streamAudible).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("密钥不进渲染进程契约", () => {
  it("通用云 ASR 密钥不再读取或写入，状态和日志都不含明文", async () => {
    const backend = new MemorySecretBackend(true);
    await backend.set(SECRET);
    const get = vi.spyOn(backend, "get");
    const set = vi.spyOn(backend, "set");
    const store = new SecretStore({ backend, allowEnvFallback: true, env: { DINGBO_CLOUD_ASR_KEY: SECRET } });

    const status = await store.status();
    expect(status).toMatchObject({ configured: false, source: "none", editable: false });
    expect(status.message).toContain("废弃");
    expect(JSON.stringify(status)).not.toContain(SECRET);
    expect(await store.readCloudAsrKey()).toBeNull();

    const saved = await store.setCloudAsrKey(SECRET);
    expect(saved.configured).toBe(false);
    expect(saved.message).toContain("未写入");
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect(set).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();

    const cleared = await store.clearCloudAsrKey();
    expect(cleared.message).toContain("清除");
    expect(JSON.stringify(cleared)).not.toContain(SECRET);
    expect(get).not.toHaveBeenCalled();
    expect(await backend.get()).toBeNull();

    const packaged = new SecretStore({
      backend: new MemorySecretBackend(false),
      allowEnvFallback: false,
      env: { DINGBO_CLOUD_ASR_KEY: SECRET },
    });
    expect((await packaged.status()).configured).toBe(false);
    expect(JSON.stringify(await packaged.status())).not.toContain(SECRET);
    expect(await packaged.readCloudAsrKey()).toBeNull();

    expect(parseSecretSet({ key: SECRET })).toEqual({ key: SECRET });
    expect(parseSecretSet({ key: "bad\nkey" })).toBeNull();
    expect(parseSecretSet({ key: SECRET, extra: true })).toBeNull();

    noteSensitive(SECRET);
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logEvent("info", "secrets", "status", { message: `使用 ${SECRET}`, text: "完整转写不该出现" });
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).not.toContain(SECRET);
    expect(line).toContain("[redacted]");
    expect(line).not.toContain("完整转写不该出现");
    spy.mockRestore();
    log.mockRestore();
  });
});

describe("讯飞 RTASR 凭据与开始参数", () => {
  it("双凭据独立加密存储，只返回状态；开发环境回退必须成对配置", async () => {
    const appId = "xfyun-test-app-id";
    const apiKey = "xfyun-test-api-key";
    const store = new SecretStore({
      backend: new MemorySecretBackend(true),
      xfyunBackend: new MemorySecretBackend(true),
      allowEnvFallback: false,
      env: { DINGBO_XFYUN_APP_ID: appId, DINGBO_XFYUN_API_KEY: apiKey },
    });
    expect(await store.readXfyunCredentials()).toBeNull();
    expect((await store.status("xfyun")).configured).toBe(false);

    const saved = await store.setXfyunCredentials({ appId, apiKey });
    expect(saved).toMatchObject({ configured: true, source: "os", backend: "os" });
    expect(JSON.stringify(saved)).not.toContain(appId);
    expect(JSON.stringify(saved)).not.toContain(apiKey);
    expect(await store.readXfyunCredentials()).toEqual({ appId, apiKey });
    expect((await store.clearXfyunCredentials()).configured).toBe(false);

    const dev = new SecretStore({
      backend: new MemorySecretBackend(false),
      xfyunBackend: new MemorySecretBackend(false),
      allowEnvFallback: true,
      env: { DINGBO_XFYUN_APP_ID: appId, DINGBO_XFYUN_API_KEY: apiKey },
    });
    expect((await dev.status("xfyun")).source).toBe("env");
    expect(await dev.readXfyunCredentials()).toEqual({ appId, apiKey });
    expect(parseXfyunSecretSet({ appId, apiKey })).toEqual({ appId, apiKey });
    expect(parseXfyunSecretSet({ appId, apiKey: "bad\nkey" })).toBeNull();
    expect(parseXfyunSecretSet({ appId, apiKey, extra: true })).toBeNull();
    expect(parseSessionStart({ audioSource: "loopback", asrId: "xfyun" })).toEqual({ audioSource: "loopback", asrId: "xfyun" });
  });
});

describe("JSONL 复盘", () => {
  it("停止后可以按事件重新载入，和内存里的问题、字幕一致", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(path.join(tmpdir(), "dingbo-replay-"));
    try {
      const controller = new SessionController({
        getReplayRoot: () => root,
        createAsr: () => new FakeAsrAdapter({ loop: false, utterances: DEMO_UTTERANCES }),
        createPump: () => new SimulatedAudioPumpShim(),
      });
      const started = await controller.start({ audioSource: "simulated", asrId: "fake" });
      await vi.advanceTimersByTimeAsync(1_900);
      const stopped = await controller.stop();
      const finals = controller.getTranscript().finals;
      const issues = controller.analysisSnapshot().issues;
      expect(stopped.state).toBe("completed");
      expect(stopped.persistence).toBe("jsonl");
      expect(stopped.replayFile).toBeTruthy();
      const events = loadSessionReplay(stopped.replayFile ?? "");
      expect(events[0]?.type).toBe("session_started");
      expect(events.at(-1)?.type).toBe("session_stopped");
      expect(events.some((event) => event.type === "framework_loaded")).toBe(true);
      expect(events.some((event) => event.type === "analysis_completed" && event.payload.finalFlush === true)).toBe(true);
      expect(replayFinals(events).some((item) => item.text.includes("直播间"))).toBe(true);
      expect(replayFinals(events).map((item) => item.text)).toEqual(finals.map((item) => item.text));
      expect(replayIssues(events).map((issue) => issue.id).sort()).toEqual(issues.map((issue) => issue.id).sort());
      expect(events.map((event) => event.sessionId).every((id) => id === started.sessionId)).toBe(true);
      const reread = controller.currentReplay();
      expect(reread.ok).toBe(true);
      if (reread.ok) {
        expect(reread.replay.summary.sessionId).toBe(started.sessionId);
        expect(reread.replay.finals.map((item) => item.text)).toEqual(finals.map((item) => item.text));
        expect(reread.replay.issues.map((issue) => issue.id).sort()).toEqual(issues.map((issue) => issue.id).sort());
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("转写里出现密钥时，复盘文件会打码，写失败则留在内存并进入 error", async () => {
    vi.useFakeTimers();
    noteSensitive(SECRET);
    const root = mkdtempSync(path.join(tmpdir(), "dingbo-replay-secret-"));
    const leaked = [{ startMs: 0, endMs: 400, text: `今天的口令是 ${SECRET} ，卖点记得讲。` }];
    try {
      const leakedController = new SessionController({
        getReplayRoot: () => root,
        createAsr: () => new FakeAsrAdapter({ loop: false, utterances: leaked }),
        createPump: () => new SimulatedAudioPumpShim(leaked),
      });
      await leakedController.start({ audioSource: "simulated", asrId: "fake" });
      await vi.advanceTimersByTimeAsync(500);
      const saved = await leakedController.stop();
      expect(saved.state).toBe("completed");
      const file = readFileSync(saved.replayFile ?? "", "utf8");
      expect(file).not.toContain(SECRET);
      expect(file).toContain("[redacted]");
      expect(leakedController.getTranscript().finals.some((item) => item.text.includes(SECRET))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const failing = new SessionController({
      writeReplay: () => ({ ok: false, message: "复盘文件没有写成，本场数据仍留在内存里，关闭窗口后会丢失。" }),
      createAsr: () => new FakeAsrAdapter({ loop: false, utterances: DEMO_UTTERANCES }),
      createPump: () => new SimulatedAudioPumpShim(),
    });
    await failing.start({ audioSource: "simulated", asrId: "fake" });
    await vi.advanceTimersByTimeAsync(1_900);
    const stopped = await failing.stop();
    expect(stopped.state).toBe("error");
    expect(stopped.error?.code).toBe("replay_failed");
    expect(stopped.persistence).toBe("memory");
    expect(stopped.stopWarning).toContain("内存");
    expect(failing.getTranscript().finals.some((item) => item.text.includes("直播间"))).toBe(true);
    expect(failing.analysisSnapshot().issues).toBeDefined();
  });
});

describe("错误恢复", () => {
  it("采音中断按 1/2/4/8 秒重连，超过 5 次进入 error，期间来帧可以恢复", async () => {
    vi.useFakeTimers();
    const pump = new ManualPump();
    const controller = new SessionController({
      createAsr: () => new FakeAsrAdapter({ loop: false, utterances: [] }),
      createPump: () => pump,
    });
    await controller.start({ audioSource: "loopback", asrId: "fake" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(controller.snapshot().state).toBe("degraded");
    expect(controller.snapshot().degradedReason).toContain("3");
    expect(controller.snapshot().reconnectAttempt).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(pump.rearms).toBe(1);
    pump.emit(frame(40));
    expect(controller.snapshot().state).toBe("running");
    expect(controller.snapshot().reconnectAttempt).toBeNull();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(controller.snapshot().state).toBe("degraded");
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 + 8_000 + 8_000);
    expect(pump.rearms).toBe(6);
    expect(controller.snapshot().state).toBe("error");
    expect(controller.snapshot().error?.code).toBe("reconnect_exhausted");
    expect(transition("degraded", "GIVE_UP")).toBe("error");
    await controller.stop();
  });

  it("识别断线会重开适配器，不因为音频帧还在就假装恢复", async () => {
    vi.useFakeTimers();
    const asr = new FlakyAsr();
    const pump = new ManualPump();
    const controller = new SessionController({
      createAsr: () => asr,
      createPump: () => pump,
    });
    const started = await controller.start({ audioSource: "loopback", asrId: "fake" });
    expect(started.state).toBe("running");
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot().state).toBe("degraded");
    expect(controller.snapshot().degradedReason).toContain("socket");
    pump.emit(frame(80));
    expect(controller.snapshot().state).toBe("degraded");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(asr.starts).toBe(2);
    expect(controller.snapshot().state).toBe("running");
    expect(controller.snapshot().phaseDetail).toContain("缺口");
    await controller.stop();
  });

  it("讯飞鉴权失败不可重试，重连时直接结束而不是耗尽五次预算", async () => {
    vi.useFakeTimers();
    const asr = new TerminalXfyunAsr();
    const pump = new ManualPump();
    const controller = new SessionController({
      createAsr: () => asr,
      createPump: () => pump,
    });
    await controller.start({ audioSource: "loopback", asrId: "xfyun" });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot().state).toBe("degraded");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(asr.starts).toBe(2);
    expect(controller.snapshot().state).toBe("error");
    expect(controller.snapshot().degradedReason).toContain("无法自动恢复");
    expect(controller.snapshot().error?.message).toContain("无法自动恢复");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(asr.starts).toBe(2);
  });

  it("分析重入只记 overrun，不并行堆积", () => {
    const calls: number[] = [];
    let overruns = 0;
    const scheduler = new WindowScheduler({
      getWindowMs: () => 60_000,
      getIntervalMs: () => 15_000,
      onAnalyze: (request) => {
        calls.push(request.endMs);
        if (calls.length === 1) scheduler.tick(request.endMs + 15_000);
      },
      onOverrun: () => {
        overruns += 1;
      },
    });
    scheduler.start();
    scheduler.tick(60_000);
    expect(calls).toEqual([60_000]);
    expect(overruns).toBe(1);
  });
});

describe("30 分钟注入", () => {
  it("Fake ASR 连续覆盖 30 分钟音频时钟，问题按指纹合并", async () => {
    applySettingsUpdate({ windowMs: 60_000, intervalMs: 60_000 });
    const utterances = [{ startMs: 0, endMs: 1_000, text: "大家好，欢迎来到今天的直播间，核心卖点先说清楚。" }];
    const pump = new ClockPump();
    const root = mkdtempSync(path.join(tmpdir(), "dingbo-soak-"));
    try {
      const controller = new SessionController({
        getReplayRoot: () => root,
        createAsr: () => new FakeAsrAdapter({ loop: true, utterances }),
        createPump: () => pump,
      });
      const started = await controller.start({ audioSource: "simulated", asrId: "fake" });
      expect(started.state).toBe("running");
      const sessionId = started.sessionId ?? "";
      const total = 30 * 60 * 1000;
      for (let startMs = 0; startMs < total; startMs += 200) {
        pump.emit(speechFrame(sessionId, startMs, 200, utterances));
      }
      const snapshot = controller.snapshot();
      expect(snapshot.state).toBe("running");
      expect(snapshot.audioClockMs).toBe(total);
      expect(controller.getTranscript().finals.length).toBeGreaterThan(500);
      const issues = controller.analysisSnapshot().issues;
      expect(new Set(issues.map((issue) => issue.fingerprint)).size).toBe(issues.length);
      expect(issues.some((issue) => issue.occurrenceCount > 5)).toBe(true);
      const stopped = await controller.stop();
      expect(stopped.state).toBe("completed");
      expect(stopped.persistence).toBe("jsonl");
      const file = readFileSync(stopped.replayFile ?? "", "utf8");
      expect(file.length).toBeGreaterThan(1_000);
      expect(file).not.toContain("samples");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

class SimulatedAudioPumpShim implements AudioPump {
  readonly id = "simulated" as const;
  readonly monitorsLiveness = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private readonly utterances: readonly { startMs: number; endMs: number; text: string }[];

  constructor(utterances: readonly { startMs: number; endMs: number; text: string }[] = DEMO_UTTERANCES) {
    this.utterances = utterances;
  }

  prepare(): void {}

  async start(sessionId: string, sink: AudioSink): Promise<void> {
    this.timer = setInterval(() => {
      const startMs = this.seq * 20;
      this.seq += 1;
      sink.onFrame(speechFrame(sessionId, startMs, 20, this.utterances));
    }, 20);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

class ManualPump implements AudioPump {
  readonly id = "loopback" as const;
  readonly monitorsLiveness = true;
  rearms = 0;
  private sink: AudioSink | null = null;
  private sessionId = "";

  prepare(): void {}

  async start(sessionId: string, sink: AudioSink): Promise<void> {
    this.sessionId = sessionId;
    this.sink = sink;
    sink.onFrame(frame(0, sessionId));
  }

  async stop(): Promise<void> {
    this.sink = null;
  }

  rearm(): void {
    this.rearms += 1;
  }

  emit(next: Frame): void {
    this.sink?.onFrame({ ...next, sessionId: this.sessionId });
  }
}

class ClockPump implements AudioPump {
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

  emit(next: AudioFrame): void {
    this.sink?.onFrame(next);
  }
}

class TerminalXfyunAsr extends FakeAsrAdapter {
  starts = 0;
  private pushes = 0;

  constructor() {
    super({ loop: false, utterances: [] });
  }

  override async start(config: AsrStartConfig): Promise<void> {
    this.starts += 1;
    if (this.starts > 1) {
      throw new XfyunServiceError({ code: "unauthorized", message: "讯飞鉴权失败" }, false);
    }
    await super.start(config);
  }

  override async push(next: AudioFrame): Promise<void> {
    this.pushes += 1;
    if (this.pushes === 1) throw new Error("socket down");
    await super.push(next);
  }
}

class FlakyAsr extends FakeAsrAdapter {
  starts = 0;
  private pushes = 0;

  constructor() {
    super({ loop: false, utterances: [] });
  }

  override async start(config: AsrStartConfig): Promise<void> {
    this.starts += 1;
    await super.start(config);
  }

  override async push(next: AudioFrame): Promise<void> {
    this.pushes += 1;
    if (this.pushes === 1) throw new Error("socket down");
    await super.push(next);
  }
}

function frame(startMs: number, sessionId = "ignored"): AudioFrame {
  return {
    sessionId,
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

function speechFrame(
  sessionId: string,
  startMs: number,
  durationMs: number,
  utterances: readonly { startMs: number; endMs: number }[],
): AudioFrame {
  const cycle = Math.max(1, utterances.reduce((max, item) => Math.max(max, item.endMs), 0) + 800);
  const local = startMs % cycle;
  const speech = utterances.some((item) => local >= item.startMs && local < item.endMs);
  return {
    sessionId,
    seq: startMs / durationMs,
    startMs,
    durationMs,
    sampleRate: 16000,
    channels: 1,
    encoding: "pcm_s16le",
    samples: new Int16Array(320),
    rms: speech ? 0.2 : 0,
    speechProbability: speech ? 0.9 : 0,
  } as AudioFrame;
}
