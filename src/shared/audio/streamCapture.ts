/**
 * 直播流抽音的纯策略。浏览器里真正接 WebAudio 的代码在 preload/streamTap.ts，
 * 这里只决定「抽哪一个媒体元素、什么时候换抽法、隐藏画面时页面要不要保持可见」。
 */

export const STREAM_RETARGET_SCORE_GAP = 500;
export const STREAM_SILENT_TAP_MS = 5_000;
export const STREAM_DIGITAL_SILENCE_RMS = 0.0005;
export const STREAM_ELEMENT_SOURCE_WAIT_MS = 3_000;
export const STREAM_ALTERNATE_BYTE_GAP = 8_000;

export type StreamMediaSnapshot = {
  key: string;
  tag: "audio" | "video";
  paused: boolean;
  ended: boolean;
  /** 元素静音，或音量被当成静音。 */
  muted: boolean;
  volume: number;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  currentTime: number;
  audioDecodedBytes: number;
  audioTrackCount: number;
};

export type TapKind = "stream" | "element";

/**
 * 用户点「隐藏画面」时，页面仍必须算前台。
 * `BrowserWindow.hide()` 会让 document.hidden = true：外放开着时扬声器还能响，
 * WebAudio / captureStream 却收到全零，FunASR 就没有字幕。
 * 外放开关不靠 hide，也不靠媒体元素 muted，见 streamSpeakerMuted。
 */
export type StreamWindowMode = {
  keepPageVisible: true;
  opacity: number;
  skipTaskbar: boolean;
  passThroughMouse: boolean;
  alwaysOnTop: boolean;
  focusable: boolean;
};

/**
 * 直播窗系统扬声器是否静音。交给 webContents.setAudioMuted。
 * 与画面是否可见无关，也不要把媒体元素设成 muted 或 volume 0，否则抽头会变成数字静音。
 */
export function streamSpeakerMuted(audible: boolean): boolean {
  return !audible;
}

/**
 * macOS 隐藏采集窗用 NSPanel（Electron `type: "panel"`）。
 * Panel 不进普通 Mission Control 窗口列表，减少被当成另一个桌面窗口而切 Space。
 * 抽音在这个窗口的 webContents 里走 captureStream，不依赖窗口类型。
 * 如果某次 Electron / macOS 升级后 panel 没有声音、页面被挂起或画面透出来，
 * 把这里改成 false：退回普通 BrowserWindow，仍用 showInactive + opacity 0，
 * 并且不会再用 screen-saver 级别置顶。
 */
export const MAC_STREAM_USE_PANEL = true;

/** macOS 首帧超时：不 show() 直播窗，只在主界面提示。用户再点「显示画面」。 */
export const STREAM_CAPTURE_STALL_MESSAGE =
  "还没收到直播音频。直播页保持隐藏，不会切到别的桌面。需要扫码登录时，点「显示直播画面」。";

export type StreamWindowRect = { x: number; y: number; width: number; height: number };

export function streamBrowserWindowType(platform: string): "panel" | undefined {
  if (platform === "darwin" && MAC_STREAM_USE_PANEL) return "panel";
  return undefined;
}

export function streamWindowMode(userVisible: boolean, platform: string): StreamWindowMode {
  if (userVisible) {
    return {
      keepPageVisible: true,
      opacity: 1,
      skipTaskbar: false,
      passThroughMouse: false,
      alwaysOnTop: false,
      focusable: true,
    };
  }
  return {
    keepPageVisible: true,
    opacity: 0,
    skipTaskbar: true,
    passThroughMouse: true,
    // 非 macOS 仍置顶，避免被挡住后抽成全零。macOS 的 screen-saver 级别会切 Space，这里关掉。
    alwaysOnTop: platform !== "darwin",
    focusable: false,
  };
}

/** 把直播窗放进控制窗所在显示器的工作区，尽量居中，不超出工作区。 */
export function streamWindowBoundsOnDisplay(
  area: StreamWindowRect,
  size: { width: number; height: number },
): StreamWindowRect {
  const width = Math.min(Math.max(size.width, 1), Math.max(area.width, 1));
  const height = Math.min(Math.max(size.height, 1), Math.max(area.height, 1));
  return {
    x: area.x + Math.max(0, Math.round((area.width - width) / 2)),
    y: area.y + Math.max(0, Math.round((area.height - height) / 2)),
    width,
    height,
  };
}

export function streamNoFramesMessage(timeoutMs: number, platform: string): string {
  const head = `${timeoutMs / 1000} 秒内没有收到直播音频。可能主播未开播、需要登录，或该直播间不支持网页播放。`;
  if (platform === "darwin") return `${head}画面仍保持隐藏，可点「显示直播画面」登录后再试。`;
  return `${head}已打开直播画面，可完成登录后重试。`;
}

export function floatEnergy(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

export function scoreStreamMedia(item: StreamMediaSnapshot): number {
  if (item.ended || item.readyState < 2) return -1;
  let score = 0;
  if (!item.paused) score += 5_000;
  if (!item.muted && item.volume > 0) score += 800;
  if (item.audioDecodedBytes > 0) score += 600;
  if (item.audioTrackCount > 0) score += 200;
  if (item.tag === "video") score += Math.min(item.videoWidth * item.videoHeight, 2_000_000) / 1_000;
  else score += 1_000;
  if (item.currentTime > 0.2) score += 100;
  return score;
}

/**
 * 返回应该改抽的元素。null 表示继续抽当前这个。
 * 正在播、未静音、画面更大的优先；全零超过 5 秒且另一个元素明显在解码音频时改抽那个。
 */
export function chooseStreamMedia(
  current: StreamMediaSnapshot | null,
  candidates: readonly StreamMediaSnapshot[],
  silentForMs = 0,
): StreamMediaSnapshot | null {
  const viable = candidates.filter((item) => scoreStreamMedia(item) >= 0);
  if (viable.length === 0) return null;
  const best = viable.reduce((left, right) => (scoreStreamMedia(right) > scoreStreamMedia(left) ? right : left));
  if (!current) return best;
  if (!viable.some((item) => item.key === current.key)) return best;
  if (current.key !== best.key && scoreStreamMedia(best) >= scoreStreamMedia(current) + STREAM_RETARGET_SCORE_GAP) {
    return best;
  }
  if (silentForMs < STREAM_SILENT_TAP_MS || current.key !== best.key) return null;
  const alternate = viable
    .filter((item) => item.key !== current.key)
    .reduce<StreamMediaSnapshot | null>((left, right) => {
      if (!left || right.audioDecodedBytes > left.audioDecodedBytes) return right;
      return left;
    }, null);
  if (alternate && alternate.audioDecodedBytes > current.audioDecodedBytes + STREAM_ALTERNATE_BYTE_GAP) return alternate;
  return null;
}

/** captureStream 还没有音轨时，先等一等，避免过早 createMediaElementSource 把元素听筒掐掉。 */
export function shouldUseElementSource(input: {
  captureHasAudioTrack: boolean;
  waitedMs: number;
}): boolean {
  if (input.captureHasAudioTrack) return false;
  return input.waitedMs >= STREAM_ELEMENT_SOURCE_WAIT_MS;
}

/**
 * captureStream 已接上，但解码字节在涨、抽头却是数字静音。
 * 这时再改走 MediaElementSource。已经走了元素源就不能再换回来。
 */
export function shouldReplaceSilentTap(input: {
  kind: TapKind;
  silentForMs: number;
  audioDecodedBytesGrew: boolean;
}): boolean {
  return input.kind === "stream" && input.silentForMs >= STREAM_SILENT_TAP_MS && input.audioDecodedBytesGrew;
}

/** 还没收到采样时，用接通后的墙钟；收到全零后用采样累计。 */
export function observedTapSilence(input: { silentMs: number; samplesSeen: boolean; connectedForMs: number }): number {
  if (!input.samplesSeen) return Math.max(0, input.silentMs, input.connectedForMs);
  return Math.max(0, input.silentMs);
}
