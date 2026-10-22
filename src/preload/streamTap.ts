import {
  STREAM_ALTERNATE_BYTE_GAP,
  STREAM_DIGITAL_SILENCE_RMS,
  chooseStreamMedia,
  floatEnergy,
  observedTapSilence,
  shouldReplaceSilentTap,
  shouldUseElementSource,
  type StreamMediaSnapshot,
  type TapKind,
} from "@shared/audio/streamCapture";
import type { PcmChunkPayload } from "@shared/contracts/audio";

const TAP_NAME = "dingbo-stream-tap";

/** 与环回抽头同一路：不强制单声道，也不把输出清零。显式 mono 会把立体声媒体元素抽成全零。 */
export const STREAM_TAP_NODE_OPTIONS = {
  numberOfInputs: 1,
  numberOfOutputs: 1,
} as const;

export const STREAM_TAP_WORKLET = `
class DingboStreamTap extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || !channels[0]) return true;
    const frames = channels[0].length;
    const mono = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      let sum = 0;
      for (let c = 0; c < channels.length; c += 1) {
        const data = channels[c];
        sum += data ? data[i] || 0 : 0;
      }
      mono[i] = sum / channels.length;
    }
    this.port.postMessage(mono);
    return true;
  }
}
registerProcessor("${TAP_NAME}", DingboStreamTap);
`;

export type StreamTapOptions = {
  sessionId: string;
  send: (chunk: PcmChunkPayload) => void;
  onError: (message: string) => void;
};

type Link = {
  key: string;
  element: HTMLMediaElement;
  kind: TapKind;
  trackCount: number;
  bytesAtConnect: number;
  connectedAt: number;
  disconnect: () => void;
};

/**
 * 在隔离世界里把直播间正在出声的媒体旁路成 PCM。
 * 优先 captureStream：不把 <video> 从扬声器上摘下来。外放与否由主进程
 * webContents.setAudioMuted 决定，这里不把元素设成 muted，否则抽头会变成数字静音。
 * 不抽 document 里的第一个 video——抖音页上常有静音预览，它结束会把整场采音判死。
 */
export function installStreamTap(options: StreamTapOptions): () => void {
  const context = new AudioContext();
  // 抽头接到静音 gain，避免 WebAudio 再放一路。页面 <video> 的扬声器不在这里关。
  const mute = context.createGain();
  mute.gain.value = 0;
  mute.connect(context.destination);

  const keys = new WeakMap<HTMLMediaElement, string>();
  const elementSourceTried = new WeakSet<HTMLMediaElement>();
  let keySeq = 0;
  let input: AudioNode | null = null;
  let pending: Float32Array = new Float32Array(0);
  let queuedMs = 0;
  let waitingKey: string | null = null;
  let waitingSince = 0;

  const state: {
    stopped: boolean;
    link: Link | null;
    hasSource: boolean;
    silentMs: number;
    samplesSeen: boolean;
    reportedFatal: boolean;
  } = {
    stopped: false,
    link: null,
    hasSource: false,
    silentMs: 0,
    samplesSeen: false,
    reportedFatal: false,
  };

  const keyOf = (element: HTMLMediaElement): string => {
    const existing = keys.get(element);
    if (existing) return existing;
    keySeq += 1;
    const key = `m${keySeq}`;
    keys.set(element, key);
    return key;
  };

  const audioBytes = (element: HTMLMediaElement): number => {
    const withBytes = element as HTMLMediaElement & { webkitAudioDecodedByteCount?: number };
    return withBytes.webkitAudioDecodedByteCount ?? 0;
  };

  const describe = (element: HTMLMediaElement, audioTrackCount: number): StreamMediaSnapshot => ({
    key: keyOf(element),
    tag: element instanceof HTMLAudioElement ? "audio" : "video",
    paused: element.paused,
    ended: element.ended,
    muted: element.muted,
    volume: element.volume,
    readyState: element.readyState,
    videoWidth: element instanceof HTMLVideoElement ? element.videoWidth : 0,
    videoHeight: element instanceof HTMLVideoElement ? element.videoHeight : 0,
    currentTime: Number.isFinite(element.currentTime) ? element.currentTime : 0,
    audioDecodedBytes: audioBytes(element),
    audioTrackCount,
  });

  const emit = (samples: Float32Array) => {
    if (state.stopped || samples.length === 0) return;
    state.samplesSeen = true;
    const sampleRate = context.sampleRate || 48_000;
    const durationMs = (samples.length / sampleRate) * 1000;
    if (floatEnergy(samples) < STREAM_DIGITAL_SILENCE_RMS) state.silentMs += durationMs;
    else state.silentMs = 0;
    pending = concatFloat(pending, samples);
    const target = Math.max(1, Math.floor(sampleRate * 0.1));
    if (pending.length < target) return;
    const chunkSamples = pending;
    pending = new Float32Array(0);
    const capturedAtMs = Math.max(0, queuedMs);
    queuedMs += (chunkSamples.length / sampleRate) * 1000;
    options.send({
      sessionId: options.sessionId,
      sampleRate,
      channels: 1,
      capturedAtMs,
      samples: chunkSamples,
    });
  };

  const silenceFor = (): number => {
    const connectedForMs = state.link ? Math.max(0, Date.now() - state.link.connectedAt) : 0;
    return observedTapSilence({
      silentMs: state.silentMs,
      samplesSeen: state.samplesSeen,
      connectedForMs,
    });
  };

  const onEnded = (event: Event) => {
    if (state.stopped) return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLMediaElement) || state.link?.element !== target) return;
    release();
    const next = chooseStreamMedia(null, collectSnapshots(), 0);
    const element = next ? elementByKey(next.key) : null;
    if (next && element) connect(element, next);
    else reportFatal("直播画面的音频已中断，可能主播已下播。");
  };

  const release = () => {
    const link = state.link;
    if (!link) return;
    link.element.removeEventListener("ended", onEnded);
    link.disconnect();
    state.link = null;
    state.hasSource = false;
  };

  const reportFatal = (message: string) => {
    if (state.reportedFatal) return;
    state.reportedFatal = true;
    options.onError(message);
  };

  const swap = (next: Link) => {
    const previous = state.link;
    if (previous && previous.element !== next.element) previous.element.removeEventListener("ended", onEnded);
    previous?.disconnect();
    state.link = next;
    state.hasSource = true;
    state.silentMs = 0;
    state.samplesSeen = false;
    state.reportedFatal = false;
    waitingKey = null;
    if (!previous || previous.element !== next.element) next.element.addEventListener("ended", onEnded);
    // 元素静音会让抽头变全零。外放开关不走这里，走主进程 setAudioMuted。
    if (next.element.muted || next.element.volume <= 0) {
      next.element.muted = false;
      next.element.volume = 1;
    }
    if (next.element.paused && !next.element.ended) void next.element.play().catch(() => undefined);
  };

  const tryStream = (element: HTMLMediaElement): Link | null => {
    if (!input) return null;
    let stream: MediaStream;
    try {
      const capture = (element as HTMLMediaElement & { captureStream?: () => MediaStream }).captureStream;
      if (!capture) return null;
      stream = capture.call(element);
    } catch {
      return null;
    }
    const tracks = stream.getAudioTracks();
    if (tracks.length === 0) return null;
    try {
      const source = context.createMediaStreamSource(stream);
      source.connect(input);
      return {
        key: keyOf(element),
        element,
        kind: "stream",
        trackCount: tracks.length,
        bytesAtConnect: audioBytes(element),
        connectedAt: Date.now(),
        disconnect: () => source.disconnect(),
      };
    } catch {
      return null;
    }
  };

  const tryElement = (element: HTMLMediaElement): Link | null => {
    if (!input || elementSourceTried.has(element)) return null;
    elementSourceTried.add(element);
    try {
      const source = context.createMediaElementSource(element);
      source.connect(input);
      return {
        key: keyOf(element),
        element,
        kind: "element",
        trackCount: 0,
        bytesAtConnect: audioBytes(element),
        connectedAt: Date.now(),
        disconnect: () => source.disconnect(),
      };
    } catch {
      return null;
    }
  };

  const connect = (element: HTMLMediaElement, snap: StreamMediaSnapshot) => {
    if (state.link?.key === snap.key) return;
    const streamLink = tryStream(element);
    if (streamLink) {
      swap(streamLink);
      return;
    }
    if (waitingKey !== snap.key) {
      waitingKey = snap.key;
      waitingSince = Date.now();
    }
    if (!shouldUseElementSource({ captureHasAudioTrack: false, waitedMs: Date.now() - waitingSince })) return;
    const elementLink = tryElement(element);
    if (elementLink) swap(elementLink);
  };

  const maybeUpgrade = (link: Link) => {
    if (link.kind !== "stream") return;
    const grew = audioBytes(link.element) > link.bytesAtConnect + STREAM_ALTERNATE_BYTE_GAP;
    if (!shouldReplaceSilentTap({ kind: link.kind, silentForMs: silenceFor(), audioDecodedBytesGrew: grew })) return;
    const next = tryElement(link.element);
    if (next) swap(next);
  };

  const elementByKey = (key: string): HTMLMediaElement | null => {
    for (const element of collectMedia(document)) {
      if (keyOf(element) === key) return element;
    }
    return null;
  };

  const collectSnapshots = (): StreamMediaSnapshot[] =>
    collectMedia(document).map((element) => describe(element, state.link?.element === element ? state.link.trackCount : 0));

  const scan = () => {
    if (state.stopped) return;
    if (context.state !== "running") void context.resume().catch(() => undefined);
    if (!input) return;
    const elements = collectMedia(document);
    const snaps = elements.map((element) => describe(element, state.link?.element === element ? state.link.trackCount : 0));
    const current = state.link ? describe(state.link.element, state.link.trackCount) : null;
    const choice = chooseStreamMedia(current, snaps, silenceFor());
    if (choice) {
      const element = elements.find((item) => keyOf(item) === choice.key);
      if (element) connect(element, choice);
      return;
    }
    if (state.link) maybeUpgrade(state.link);
  };

  void createTap(context, emit, mute, () => state.hasSource).then((node) => {
    input = node;
    if (!input && !state.stopped) reportFatal("无法接入直播音频：当前环境没有可用的音频抽头。");
    scan();
  });

  const ticker = setInterval(scan, 500);

  const cleanup = () => {
    if (state.stopped) return;
    state.stopped = true;
    clearInterval(ticker);
    release();
    input?.disconnect();
    void context.close().catch(() => undefined);
  };

  window.addEventListener("pagehide", cleanup, { once: true });
  return cleanup;
}

async function createTap(
  context: AudioContext,
  emit: (samples: Float32Array) => void,
  mute: GainNode,
  hasSource: () => boolean,
): Promise<AudioNode | null> {
  try {
    const url = URL.createObjectURL(new Blob([STREAM_TAP_WORKLET], { type: "application/javascript" }));
    await context.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(context, TAP_NAME, STREAM_TAP_NODE_OPTIONS);
    node.port.onmessage = (event: MessageEvent<Float32Array>) => emit(event.data);
    node.connect(mute);
    return node;
  } catch {
    try {
      const processor = context.createScriptProcessor(2048, 2, 2);
      processor.onaudioprocess = (event) => {
        if (!hasSource()) return;
        const input = event.inputBuffer;
        const channels = input.numberOfChannels;
        const frames = input.length;
        const mono = new Float32Array(frames);
        for (let i = 0; i < frames; i += 1) {
          let sum = 0;
          for (let c = 0; c < channels; c += 1) sum += input.getChannelData(c)[i] ?? 0;
          mono[i] = channels > 0 ? sum / channels : 0;
        }
        emit(mono);
      };
      processor.connect(mute);
      return processor;
    } catch {
      return null;
    }
  }
}

function collectMedia(root: ParentNode, out: HTMLMediaElement[] = []): HTMLMediaElement[] {
  const nodes = root.querySelectorAll("video, audio");
  for (const node of nodes) {
    if (node instanceof HTMLMediaElement && node.isConnected) out.push(node);
  }
  const hosts = root.querySelectorAll("*");
  for (const host of hosts) {
    if (host instanceof HTMLElement && host.shadowRoot) collectMedia(host.shadowRoot, out);
  }
  return out;
}

function concatFloat(left: Float32Array, right: Float32Array): Float32Array {
  if (left.length === 0) return right;
  const out = new Float32Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}
