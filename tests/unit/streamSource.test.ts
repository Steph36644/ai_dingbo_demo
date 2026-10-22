import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIO } from "../../src/shared/config/defaults";
import { StreamAudioPump, type StreamCaptureHooks } from "../../src/main/audio/streamSource";
import { FakeAsrAdapter } from "../../src/main/asr/FakeAsrAdapter";
import { SessionController } from "../../src/main/session/SessionController";
import { DEMO_UTTERANCES } from "../../src/shared/fixtures/demoUtterances";
import type { AudioFrame, PcmChunkPayload } from "../../src/shared/contracts/audio";

const URL_UNDER_TEST = "https://live.douyin.com/295178185857";

function makeHooks(overrides: Partial<StreamCaptureHooks> = {}) {
  return {
    url: URL_UNDER_TEST,
    open: vi.fn(),
    close: vi.fn(),
    reload: vi.fn(),
    reveal: vi.fn(),
    ...overrides,
  };
}

function tone(sampleRate: number, durationMs: number, amplitude = 0.4): Float32Array {
  const length = Math.round((sampleRate * durationMs) / 1000);
  const samples = new Float32Array(length);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin((i * 2 * Math.PI * 440) / sampleRate) * amplitude;
  }
  return samples;
}

function chunk(capturedAtMs: number, samples: Float32Array, sessionId = "s1"): PcmChunkPayload {
  return { sessionId, sampleRate: 16_000, channels: 1, capturedAtMs, samples };
}

function makeSink() {
  const frames: AudioFrame[] = [];
  const errors: string[] = [];
  return {
    frames,
    errors,
    sink: {
      onFrame: (frame: AudioFrame) => frames.push(frame),
      onCaptureError: (error: { code: string; message: string }) => errors.push(error.message),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("直播流音频泵", () => {
  it("首帧到达前停在等待，首帧后产出 16k/mono 帧", async () => {
    vi.useFakeTimers();
    const hooks = makeHooks();
    const pump = new StreamAudioPump(hooks);
    const { frames, sink } = makeSink();

    const started = pump.start("s1", sink);
    expect(hooks.open).toHaveBeenCalledWith("s1", URL_UNDER_TEST);

    pump.ingest(chunk(0, new Float32Array(800)));
    await started;

    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]).toMatchObject({ sessionId: "s1", sampleRate: 16_000, channels: 1 });
  });

  it("超过首帧上限抛 stream_no_frames，消息里带登录提示", async () => {
    vi.useFakeTimers();
    const hooks = makeHooks({ timeoutMs: 1000 });
    const pump = new StreamAudioPump(hooks);
    const { sink } = makeSink();

    const started = pump.start("s1", sink);
    const assertion = expect(started).rejects.toThrow(/没有收到直播音频/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("迟迟没有音频时自动显示播放窗", async () => {
    vi.useFakeTimers();
    const hooks = makeHooks({ revealAfterMs: 500, timeoutMs: 5000 });
    const pump = new StreamAudioPump(hooks);
    const { sink } = makeSink();

    void pump.start("s1", sink).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(500);
    expect(hooks.reveal).toHaveBeenCalledOnce();
    await pump.stop();
  });

  it("rearm 重载页面，stop 关闭窗口", async () => {
    vi.useFakeTimers();
    const hooks = makeHooks();
    const pump = new StreamAudioPump(hooks);
    const { sink } = makeSink();

    const started = pump.start("s1", sink);
    pump.ingest(chunk(0, new Float32Array(800)));
    await started;

    pump.rearm();
    expect(hooks.reload).toHaveBeenCalledOnce();

    await pump.stop();
    expect(hooks.close).toHaveBeenCalledOnce();
  });

  it("冷却时间内重复 rearm 只重载一次，帧回来之后才允许下一次", async () => {
    vi.useFakeTimers();
    const hooks = makeHooks({ rearmCooldownMs: 30_000 });
    const pump = new StreamAudioPump(hooks);
    const { sink } = makeSink();

    const started = pump.start("s1", sink);
    pump.ingest(chunk(0, new Float32Array(800)));
    await started;

    pump.rearm();
    pump.rearm();
    expect(hooks.reload).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(29_000);
    pump.rearm();
    expect(hooks.reload).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    pump.rearm();
    expect(hooks.reload).toHaveBeenCalledTimes(2);

    pump.ingest(chunk(1_000, tone(16_000, 20)));
    pump.rearm();
    expect(hooks.reload).toHaveBeenCalledTimes(3);
    await pump.stop();
  });

  it("有能量的采样经直播流泵后仍高于语音门限，全零则是静音", async () => {
    vi.useFakeTimers();
    const hooks = makeHooks();
    const pump = new StreamAudioPump(hooks);
    const { frames, sink } = makeSink();

    const started = pump.start("s1", sink);
    pump.ingest(chunk(0, new Float32Array(960), "s1"));
    pump.ingest({ ...chunk(20, tone(48_000, 20), "s1"), sampleRate: 48_000 });
    await started;

    expect(frames[0]?.rms).toBe(0);
    expect(frames.at(-1)?.rms).toBeGreaterThan(AUDIO.speechRmsThreshold);
    await pump.stop();
  });

  it("start 未完成时 stop 以取消结束", async () => {
    vi.useFakeTimers();
    const hooks = makeHooks();
    const pump = new StreamAudioPump(hooks);
    const { sink } = makeSink();

    const started = pump.start("s1", sink);
    const assertion = expect(started).rejects.toThrow(/已取消直播流采集/);
    await pump.stop();
    await assertion;
  });
});

describe("直播流会话", () => {
  it("有能量的 PCM 能让 Fake ASR 出字幕，采音缺口只重载一次", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    let pump: StreamAudioPump | null = null;
    const levels: number[] = [];
    const controller = new SessionController({
      createAsr: () => new FakeAsrAdapter({ loop: false, utterances: DEMO_UTTERANCES }),
      createPump: () => {
        pump = new StreamAudioPump({
          url: URL_UNDER_TEST,
          open: (sessionId) => {
            pump?.ingest({
              sessionId,
              sampleRate: 16_000,
              channels: 1,
              capturedAtMs: 0,
              samples: tone(16_000, 2_000),
            });
          },
          close: () => undefined,
          reload,
          reveal: () => undefined,
          timeoutMs: 5_000,
          rearmCooldownMs: 30_000,
        });
        return pump;
      },
    });
    controller.onLevel((level) => levels.push(level.rms));
    const started = await controller.start({
      audioSource: "stream",
      asrId: "fake",
      streamUrl: URL_UNDER_TEST,
    });
    expect(started.state).toBe("running");
    expect(started.phaseDetail).toContain("已收到直播流音频帧");
    expect(Math.max(...levels)).toBeGreaterThan(AUDIO.speechRmsThreshold);
    expect(controller.getTranscript().finals.some((item) => item.text.includes("直播间"))).toBe(true);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(controller.snapshot().state).toBe("degraded");
    await vi.advanceTimersByTimeAsync(23_000);
    expect(reload).toHaveBeenCalledOnce();
    expect(controller.snapshot().state).toBe("error");
    expect(controller.snapshot().error?.code).toBe("reconnect_exhausted");
  });
});
