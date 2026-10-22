import type { PcmChunkPayload } from "@shared/contracts/audio";

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export async function primeLoopbackCapture(video: HTMLVideoElement): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("当前环境没有 getDisplayMedia，不能打开系统环回。");
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stopStream(stream);
    throw new Error("系统没有返回音频轨。这次不能算环回成功。");
  }
  const track = audioTracks[0];
  if (!track || track.readyState === "ended") {
    stopStream(stream);
    throw new Error("音频轨立刻结束。通常是没有系统音频录制权限。应用不会进入盯播中。");
  }
  video.srcObject = stream;
  video.muted = true;
  await video.play().catch(() => undefined);
  return stream;
}

export function pipeLoopback(
  stream: MediaStream,
  sessionId: string,
  push: (chunk: PcmChunkPayload) => void,
  onFailure: (message: string) => void,
): () => void {
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const mute = audioContext.createGain();
  mute.gain.value = 0;
  let stopped = false;
  let pending: Float32Array<ArrayBufferLike> = new Float32Array(0);
  let queuedMs = 0;

  const track = stream.getAudioTracks()[0];
  const onEnded = () => {
    if (!stopped) onFailure("音频轨已结束。环回中断，不会用静音填成正常字幕。");
  };
  track?.addEventListener("ended", onEnded);

  const emit = (samples: Float32Array) => {
    if (stopped || samples.length === 0) return;
    pending = concatFloat(pending, samples);
    const sampleRate = audioContext.sampleRate;
    const target = Math.max(1, Math.floor(sampleRate * 0.1));
    if (pending.length < target) return;
    const chunkSamples = pending;
    pending = new Float32Array(0);
    const capturedAtMs = Math.max(0, queuedMs);
    queuedMs += (chunkSamples.length / sampleRate) * 1000;
    push({
      sessionId,
      sampleRate,
      channels: 1,
      capturedAtMs,
      samples: chunkSamples,
    });
  };

  void attachTap(audioContext, source, mute, emit).catch((error: unknown) => {
    onFailure(error instanceof Error ? error.message : "无法读取环回 PCM");
  });

  return () => {
    stopped = true;
    track?.removeEventListener("ended", onEnded);
    void audioContext.close();
  };
}

async function attachTap(
  audioContext: AudioContext,
  source: MediaStreamAudioSourceNode,
  mute: GainNode,
  emit: (samples: Float32Array) => void,
): Promise<void> {
  try {
    await audioContext.audioWorklet.addModule(new URL("../../audio/pcm-worklet.js", import.meta.url));
    const node = new AudioWorkletNode(audioContext, "pcm-processor");
    node.port.onmessage = (event: MessageEvent<Float32Array>) => emit(event.data);
    source.connect(node);
    node.connect(mute);
    mute.connect(audioContext.destination);
    return;
  } catch {
    const processor = audioContext.createScriptProcessor(2048, source.channelCount || 1, 1);
    processor.onaudioprocess = (event) => {
      const channels = event.inputBuffer.numberOfChannels;
      const frames = event.inputBuffer.length;
      const mono = new Float32Array(frames);
      for (let i = 0; i < frames; i += 1) {
        let sum = 0;
        for (let c = 0; c < channels; c += 1) sum += event.inputBuffer.getChannelData(c)[i] ?? 0;
        mono[i] = sum / channels;
      }
      emit(mono);
    };
    source.connect(processor);
    processor.connect(mute);
    mute.connect(audioContext.destination);
  }
}

function concatFloat(left: Float32Array<ArrayBufferLike>, right: Float32Array<ArrayBufferLike>): Float32Array<ArrayBufferLike> {
  if (left.length === 0) return right;
  const out = new Float32Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}
