import { describe, expect, it, vi } from "vitest";
import { AUDIO } from "../../src/shared/config/defaults";
import { PcmFramer } from "../../src/main/audio/framer";
import { computeRms, downmixToMono, floatToInt16, resampleLinear } from "../../src/main/audio/pcm";
import { describeLoopback } from "../../src/main/audio/platformCapability";
import { probeWasapiBridge } from "../../src/main/audio/wasapiLoopback";
import { SimulatedAudioPump } from "../../src/main/audio/simulatedSource";
import type { AudioFrame } from "../../src/shared/contracts/audio";

describe("pcm", () => {
  it("把立体声平均成单声道", () => {
    const mono = downmixToMono(Float32Array.of(1, -1, 0.5, 0.5), 2);
    expect(Array.from(mono)).toEqual([0, 0.5]);
  });

  it("48 kHz 常数信号重采样后长度和幅度都稳定", () => {
    const input = new Float32Array(960).fill(0.25);
    const output = resampleLinear(input, 48_000, 16_000);
    expect(output.length).toBe(320);
    expect(output[0]).toBeCloseTo(0.25, 5);
    expect(output[100]).toBeCloseTo(0.25, 5);
  });

  it("20ms 帧是 640 字节的 S16LE", () => {
    const pcm = floatToInt16(new Float32Array(AUDIO.frameSamples).fill(0));
    expect(pcm.byteLength).toBe(AUDIO.frameBytes);
    expect(computeRms(pcm)).toBe(0);
  });
});

describe("PcmFramer", () => {
  it("切出 16kHz mono 20ms 帧，并在时钟跳变时不补零", () => {
    const framer = new PcmFramer("session-1");
    const first = framer.push({
      sampleRate: 16_000,
      channels: 1,
      capturedAtMs: 0,
      samples: new Float32Array(320).fill(0.5),
    });
    const second = framer.push({
      sampleRate: 16_000,
      channels: 1,
      capturedAtMs: 1_000,
      samples: new Float32Array(320).fill(0.5),
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      sessionId: "session-1",
      seq: 0,
      startMs: 0,
      durationMs: 20,
      sampleRate: 16_000,
      channels: 1,
      encoding: "pcm_s16le",
    });
    expect(first[0]?.samples.byteLength).toBe(640);
    expect(second.map((frame) => frame.startMs)).toEqual([1_000]);
    expect(second[0]?.seq).toBe(1);
  });

  it("全零帧 RMS 为 0，有能量的 48 kHz 语音重采样后仍高于语音门限", () => {
    const framer = new PcmFramer("session-1");
    const silent = framer.push({
      sampleRate: 48_000,
      channels: 1,
      capturedAtMs: 0,
      samples: new Float32Array(960),
    });
    expect(silent).toHaveLength(1);
    expect(silent[0]?.rms).toBe(0);
    expect(silent[0]?.speechProbability).toBe(0);

    const loud = new Float32Array(960);
    for (let i = 0; i < loud.length; i += 1) loud[i] = Math.sin((i * 2 * Math.PI * 440) / 48_000) * 0.4;
    const speech = framer.push({
      sampleRate: 48_000,
      channels: 1,
      capturedAtMs: 20,
      samples: loud,
    });
    expect(speech[0]?.rms).toBeGreaterThan(AUDIO.speechRmsThreshold);
    expect(speech[0]?.speechProbability).toBeGreaterThanOrEqual(0.5);
  });
});

describe("环回能力", () => {
  const wasapi = probeWasapiBridge(false);

  it("Windows 有屏幕源时可以尝试 Electron 环回，但原生桥接仍不可用", () => {
    const result = describeLoopback({
      platform: "win32",
      screens: [{ id: "screen:0", name: "主屏幕" }],
      wasapi,
    });
    expect(result.loopbackAvailable).toBe(true);
    expect(result.support).toBe("available");
    expect(result.captureStrategy).toBe("electron-loopback");
    expect(result.wasapiBridge.available).toBe(false);
    expect(result.devices[0]?.label).toContain("主屏幕");
    expect(result.guidance).toContain("WASAPI");
  });

  it("Windows 枚举失败时不会报告环回可用", () => {
    const result = describeLoopback({
      platform: "win32",
      screens: [],
      wasapi,
      enumerateError: "denied",
    });
    expect(result.loopbackAvailable).toBe(false);
    expect(result.loopbackAttemptAllowed).toBe(false);
    expect(result.guidance).toContain("denied");
  });

  it("macOS 只是有条件尝试，不承诺已经成功", () => {
    const result = describeLoopback({ platform: "darwin", screens: [], wasapi });
    expect(result.support).toBe("conditional");
    expect(result.loopbackAvailable).toBe(false);
    expect(result.loopbackAttemptAllowed).toBe(true);
    expect(result.guidance).toContain("权限");
    expect(result.guidance).toContain("不会显示");
  });

  it("Linux 不把模拟或 monitor 源说成可用环回", () => {
    const result = describeLoopback({ platform: "linux", screens: [], wasapi });
    expect(result.loopbackAvailable).toBe(false);
    expect(result.loopbackAttemptAllowed).toBe(false);
    expect(result.devices).toEqual([]);
    expect(result.guidance).toContain("模拟音频");
  });
});

describe("模拟音频", () => {
  it("按 20ms 产生可区分语音和静音的 PCM", async () => {
    vi.useFakeTimers();
    const frames: AudioFrame[] = [];
    const pump = new SimulatedAudioPump({ loop: false });
    await pump.start("s", {
      onFrame: (frame) => frames.push(frame),
      onCaptureError: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(2_100);
    await pump.stop();
    vi.useRealTimers();
    expect(frames.length).toBeGreaterThan(10);
    expect(frames[0]?.samples.length).toBe(320);
    expect(frames[0]?.rms).toBeGreaterThan(0.05);
    const silent = frames.find((frame) => frame.startMs >= 1_800 && frame.startMs < 2_200);
    expect(silent?.rms).toBe(0);
  });
});
