import { describe, expect, it } from "vitest";
import { STREAM_TAP_NODE_OPTIONS, STREAM_TAP_WORKLET } from "../../src/preload/streamTap";
import {
  STREAM_ALTERNATE_BYTE_GAP,
  STREAM_ELEMENT_SOURCE_WAIT_MS,
  STREAM_SILENT_TAP_MS,
  chooseStreamMedia,
  floatEnergy,
  observedTapSilence,
  scoreStreamMedia,
  shouldReplaceSilentTap,
  shouldUseElementSource,
  streamBrowserWindowType,
  streamNoFramesMessage,
  streamSpeakerMuted,
  streamWindowBoundsOnDisplay,
  streamWindowMode,
  type StreamMediaSnapshot,
} from "../../src/shared/audio/streamCapture";

function media(partial: Partial<StreamMediaSnapshot> & Pick<StreamMediaSnapshot, "key">): StreamMediaSnapshot {
  return {
    tag: "video",
    paused: false,
    ended: false,
    muted: false,
    volume: 1,
    readyState: 4,
    videoWidth: 1280,
    videoHeight: 720,
    currentTime: 12,
    audioDecodedBytes: 20_000,
    audioTrackCount: 1,
    ...partial,
  };
}

describe("直播流媒体选择", () => {
  it("不按 DOM 顺序，优先正在播放、未静音、画面更大的元素", () => {
    const preview = media({
      key: "preview",
      muted: true,
      volume: 0,
      videoWidth: 320,
      videoHeight: 180,
      audioDecodedBytes: 4_000,
    });
    const live = media({ key: "live", videoWidth: 1920, videoHeight: 1080 });
    expect(chooseStreamMedia(null, [preview, live])?.key).toBe("live");
    expect(chooseStreamMedia(null, [live, preview])?.key).toBe("live");
    expect(scoreStreamMedia(live)).toBeGreaterThan(scoreStreamMedia(preview) + 500);
  });

  it("已经抽到主画面时，不因为旁边的预览还在播就改抽", () => {
    const preview = media({ key: "preview", muted: true, volume: 0, videoWidth: 320, videoHeight: 180 });
    const live = media({ key: "live", videoWidth: 1920, videoHeight: 1080 });
    expect(chooseStreamMedia(live, [preview, live])).toBeNull();
  });

  it("先抽到预览后，主画面一开始播就改抽过去", () => {
    const preview = media({ key: "preview", muted: true, volume: 0, videoWidth: 320, videoHeight: 180 });
    const live = media({ key: "live", videoWidth: 1920, videoHeight: 1080 });
    expect(chooseStreamMedia(preview, [preview, live])?.key).toBe("live");
  });

  it("正在播的小画面胜过还没播的大画面", () => {
    const paused = media({ key: "paused", paused: true, videoWidth: 1920, videoHeight: 1080 });
    const playing = media({ key: "playing", videoWidth: 320, videoHeight: 180 });
    expect(chooseStreamMedia(null, [paused, playing])?.key).toBe("playing");
  });

  it("当前元素结束或离开文档后改抽剩下的", () => {
    const ended = media({ key: "ended", ended: true });
    const live = media({ key: "live" });
    expect(chooseStreamMedia(ended, [ended, live])?.key).toBe("live");
    expect(chooseStreamMedia(ended, [live])?.key).toBe("live");
  });

  it("大画面抽到全零、另一个元素明显在解码时，5 秒后改抽", () => {
    const silentVideo = media({
      key: "video",
      videoWidth: 1920,
      videoHeight: 1080,
      audioDecodedBytes: 0,
      audioTrackCount: 0,
    });
    const audio = media({
      key: "audio",
      tag: "audio",
      videoWidth: 0,
      videoHeight: 0,
      audioDecodedBytes: silentVideo.audioDecodedBytes + STREAM_ALTERNATE_BYTE_GAP + 1,
    });
    expect(scoreStreamMedia(silentVideo)).toBeGreaterThan(scoreStreamMedia(audio));
    expect(chooseStreamMedia(silentVideo, [silentVideo, audio], STREAM_SILENT_TAP_MS - 1)).toBeNull();
    expect(chooseStreamMedia(silentVideo, [silentVideo, audio], STREAM_SILENT_TAP_MS)?.key).toBe("audio");
  });

  it("音量关到 0 不算可听", () => {
    const quiet = media({ key: "quiet", muted: false, volume: 0 });
    const audible = media({ key: "audible", videoWidth: 640, videoHeight: 360 });
    expect(scoreStreamMedia(audible)).toBeGreaterThan(scoreStreamMedia(quiet));
  });
});

describe("抽头静音与窗口可见性", () => {
  it("全零能量是 0，有幅度的采样能量大于 0", () => {
    expect(floatEnergy(new Float32Array(32))).toBe(0);
    const loud = new Float32Array(32);
    for (let i = 0; i < loud.length; i += 1) loud[i] = i % 2 === 0 ? 0.5 : -0.5;
    expect(floatEnergy(loud)).toBeGreaterThan(0.2);
  });

  it("还没有音轨时先等，不立刻改走会掐掉扬声器的元素源", () => {
    expect(shouldUseElementSource({ captureHasAudioTrack: false, waitedMs: STREAM_ELEMENT_SOURCE_WAIT_MS - 1 })).toBe(false);
    expect(shouldUseElementSource({ captureHasAudioTrack: true, waitedMs: STREAM_ELEMENT_SOURCE_WAIT_MS })).toBe(false);
    expect(shouldUseElementSource({ captureHasAudioTrack: false, waitedMs: STREAM_ELEMENT_SOURCE_WAIT_MS })).toBe(true);
  });

  it("只有 captureStream 抽到数字静音且解码字节在涨时才换元素源", () => {
    expect(
      shouldReplaceSilentTap({ kind: "stream", silentForMs: STREAM_SILENT_TAP_MS, audioDecodedBytesGrew: true }),
    ).toBe(true);
    expect(
      shouldReplaceSilentTap({ kind: "stream", silentForMs: STREAM_SILENT_TAP_MS, audioDecodedBytesGrew: false }),
    ).toBe(false);
    expect(
      shouldReplaceSilentTap({ kind: "element", silentForMs: STREAM_SILENT_TAP_MS, audioDecodedBytesGrew: true }),
    ).toBe(false);
  });

  it("还没收到采样时用接通后的墙钟判断静音", () => {
    expect(observedTapSilence({ silentMs: 0, samplesSeen: false, connectedForMs: 5_000 })).toBe(5_000);
    expect(observedTapSilence({ silentMs: 200, samplesSeen: true, connectedForMs: 5_000 })).toBe(200);
  });

  it("外放开关只决定扬声器静音，和画面可见性分开", () => {
    expect(streamSpeakerMuted(false)).toBe(true);
    expect(streamSpeakerMuted(true)).toBe(false);
    expect(streamWindowMode(false, "win32")).not.toHaveProperty("speakerMuted");
    expect(streamWindowMode(true, "win32")).not.toHaveProperty("speakerMuted");
  });

  it("用户隐藏画面时页面仍保持可见，避免 WebAudio 被抽成全零", () => {
    expect(streamWindowMode(false, "win32")).toMatchObject({
      keepPageVisible: true,
      opacity: 0,
      skipTaskbar: true,
      passThroughMouse: true,
      alwaysOnTop: true,
      focusable: false,
    });
    expect(streamWindowMode(true, "win32")).toMatchObject({
      keepPageVisible: true,
      opacity: 1,
      skipTaskbar: false,
      passThroughMouse: false,
      focusable: true,
    });
  });

  it("macOS 隐藏时不置顶，避免 screen-saver 级别把用户拉到别的 Space", () => {
    expect(streamWindowMode(false, "darwin")).toMatchObject({
      keepPageVisible: true,
      opacity: 0,
      skipTaskbar: true,
      passThroughMouse: true,
      alwaysOnTop: false,
      focusable: false,
    });
    expect(streamWindowMode(true, "darwin").alwaysOnTop).toBe(false);
    expect(streamWindowMode(true, "darwin").opacity).toBe(1);
  });

  it("macOS 用 panel，其它平台不指定窗口类型", () => {
    expect(streamBrowserWindowType("darwin")).toBe("panel");
    expect(streamBrowserWindowType("win32")).toBeUndefined();
    expect(streamBrowserWindowType("linux")).toBeUndefined();
  });

  it("主动显示前把直播窗放进控制窗所在显示器的工作区", () => {
    expect(streamWindowBoundsOnDisplay({ x: 1920, y: 0, width: 1440, height: 900 }, { width: 480, height: 800 })).toEqual({
      x: 1920 + Math.round((1440 - 480) / 2),
      y: Math.round((900 - 800) / 2),
      width: 480,
      height: 800,
    });
    expect(streamWindowBoundsOnDisplay({ x: 10, y: 20, width: 400, height: 300 }, { width: 480, height: 800 })).toEqual({
      x: 10,
      y: 20,
      width: 400,
      height: 300,
    });
  });

  it("macOS 首帧超时文案不声称已经打开画面", () => {
    const mac = streamNoFramesMessage(30_000, "darwin");
    const win = streamNoFramesMessage(30_000, "win32");
    expect(mac).toContain("30 秒内没有收到直播音频");
    expect(mac).toContain("显示直播画面");
    expect(mac).not.toContain("已打开直播画面");
    expect(win).toBe(
      "30 秒内没有收到直播音频。可能主播未开播、需要登录，或该直播间不支持网页播放。已打开直播画面，可完成登录后重试。",
    );
  });

  it("直播流抽头不再强制单声道，也不把输出清零", () => {
    expect(STREAM_TAP_NODE_OPTIONS).toEqual({ numberOfInputs: 1, numberOfOutputs: 1 });
    expect(STREAM_TAP_NODE_OPTIONS).not.toHaveProperty("channelCount");
    expect(STREAM_TAP_WORKLET).not.toContain("channel.fill(0)");
    expect(STREAM_TAP_WORKLET).not.toContain("channelCount");
  });
});
