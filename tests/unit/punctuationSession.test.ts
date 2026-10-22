import { describe, expect, it } from "vitest";
import type { AudioFrame } from "../../src/shared/contracts/audio";
import type { AudioPump, AudioSink } from "../../src/main/audio/types";
import { FakeAsrAdapter } from "../../src/main/asr/FakeAsrAdapter";
import { SessionController } from "../../src/main/session/SessionController";
import type { ReplayEvent } from "../../src/main/session/replay";
import type { CaptionPresentation, PunctuationMode, PunctuateResponse } from "../../src/shared/contracts/transcript";
import { presentPunctuatedCaptions } from "../../src/shared/transcript/punctuationDisplay";

class ManualPump implements AudioPump {
  readonly id = "simulated" as const;
  readonly monitorsLiveness = false;
  private sink: AudioSink | null = null;

  prepare(): void {}

  async start(_sessionId: string, sink: AudioSink): Promise<void> {
    this.sink = sink;
  }

  async stop(): Promise<void> {}

  emit(frame: AudioFrame): void {
    this.sink?.onFrame(frame);
  }
}

class PunctuatingAsr extends FakeAsrAdapter {
  readonly calls: Array<{ text: string; mode: PunctuationMode }> = [];

  async punctuate(text: string, mode: PunctuationMode): Promise<PunctuateResponse> {
    this.calls.push({ text, mode });
    if (mode === "offline") {
      return { ok: true, text: `${text.replace("不错", "不错。")}。`, mode, detail: "" };
    }
    return { ok: true, text: text.replace("不错", "不错。"), mode, detail: "" };
  }
}

describe("会话里的展示标点", () => {
  it("刷新字幕但不改 JSONL 里的 final 原文", async () => {
    const asr = new PunctuatingAsr({
      loop: false,
      utterances: [
        { startMs: 0, endMs: 600, text: "今天天气不错" },
        { startMs: 600, endMs: 1_200, text: "我们继续讲" },
      ],
    });
    const pump = new ManualPump();
    const stored: ReplayEvent[] = [];
    const presentations: CaptionPresentation[] = [];
    const controller = new SessionController({
      createAsr: () => asr,
      createPump: () => pump,
      punctuation: { everyNFinals: 1, intervalMs: 4_000, requestTimeoutMs: 500, offlineTimeoutMs: 500 },
      writeReplay: (_root, _sessionId, events) => {
        stored.push(...events);
        return { ok: true, filePath: "memory://session.jsonl" };
      },
    });
    controller.onPresentation((event) => presentations.push(event));
    const started = await controller.start({ audioSource: "simulated", asrId: "funasr" });
    pump.emit({
      sessionId: started.sessionId ?? "",
      seq: 1,
      startMs: 1_300,
      durationMs: 20,
      sampleRate: 16_000,
      channels: 1,
      encoding: "pcm_s16le",
      samples: new Int16Array(320),
      rms: 0.05,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const raw = controller.getTranscript().finals.map((item) => item.text);
    expect(raw).toEqual(["今天天气不错", "我们继续讲"]);
    const live = presentations.at(-1)?.overlay ?? null;
    expect(presentPunctuatedCaptions(controller.getTranscript().finals, null, live).map((line) => line.text)).toEqual([
      "今天天气不错。",
      "我们继续讲",
    ]);

    const stopped = await controller.stop();
    expect(stopped.state).toBe("completed");
    const storedTexts = stored.filter((event) => event.type === "transcript_final").map((event) => event.payload.text);
    expect(storedTexts).toEqual(["今天天气不错", "我们继续讲"]);
    expect(JSON.stringify(stored)).not.toContain("今天天气不错。");
    expect(asr.calls.some((call) => call.mode === "offline")).toBe(true);
    expect(controller.getTranscript().finals.map((item) => item.text)).toEqual(raw);
    expect(controller.getTranscript().presentation?.mode).toBe("offline");
    expect(presentPunctuatedCaptions(controller.getTranscript().finals, null, controller.getTranscript().presentation ?? null).map((line) => line.text)).toEqual([
      "今天天气不错。",
      "我们继续讲。",
    ]);
  });
});
