import { describe, expect, it, vi } from "vitest";
import { punctuationDisplayConfig } from "../../src/shared/config/punctuation";
import type { PunctuateResponse } from "../../src/shared/contracts/transcript";
import { presentCaptions, type SentencePiece } from "../../src/shared/transcript/sentences";
import { presentPunctuatedCaptions } from "../../src/shared/transcript/punctuationDisplay";
import {
  DisplayPunctuationScheduler,
  PunctuationPass,
  type DisplayPunctuator,
} from "../../src/shared/transcript/punctuationPass";

function piece(id: string, text: string, startMs: number): SentencePiece {
  return { id, text, startMs, endMs: startMs + 600, sourceResultId: id };
}

function config(overrides: Parameters<typeof punctuationDisplayConfig>[1] = {}) {
  return punctuationDisplayConfig({}, { intervalMs: 4_000, everyNFinals: 6, maxConsecutiveFailures: 3, ...overrides });
}

function response(text: string, ok = true, detail = "", mode: PunctuateResponse["mode"] = "realtime"): PunctuateResponse {
  return { ok, text, mode, detail };
}

describe("标点节奏", () => {
  it("默认约 4 秒或 6 条 final，环境变量可改", () => {
    expect(punctuationDisplayConfig({}).intervalMs).toBe(4_000);
    expect(punctuationDisplayConfig({}).everyNFinals).toBe(6);
    expect(punctuationDisplayConfig({ DINGBO_PUNC_INTERVAL_MS: "2500", DINGBO_PUNC_EVERY_N_FINALS: "4" })).toMatchObject({
      intervalMs: 2_500,
      everyNFinals: 4,
    });
    expect(punctuationDisplayConfig({ DINGBO_PUNC_INTERVAL_MS: "10" }).intervalMs).toBe(1_000);
  });

  it("条数或间隔到了才送出，并复用前一块带过来的句号", () => {
    const pass = new PunctuationPass(config());
    pass.noteFinal(piece("a", "今天天气", 0), 1_000);
    expect(pass.millisecondsUntilDue(1_000)).toBe(4_000);
    expect(pass.begin(1_000)).toBeNull();
    for (let index = 1; index < 6; index += 1) {
      pass.noteFinal(piece(String(index), "继续", index * 600), 1_000 + index);
    }
    const batch = pass.begin(1_100);
    expect(batch?.text).toBe("今天天气继续继续继续继续继续");
    expect(batch?.reset).toBe(false);
    pass.complete(response("今天天气继续继续继续继续继续"));
    pass.noteFinal(piece("tail", "讲价", 4_000), 2_000);
    // 条数触发在 1100 送出后，下一轮间隔从这次送出重新计，而不是从第一条 final。
    expect(pass.millisecondsUntilDue(2_000)).toBe(3_100);
    const next = pass.begin(5_100);
    expect(next?.text).toBe("讲价");
    const overlay = pass.complete(response("。讲价"));
    expect(overlay?.text).toBe("今天天气继续继续继续继续继续。讲价");
    expect(presentPunctuatedCaptions(
      [piece("a", "今天天气", 0), ...[1, 2, 3, 4, 5].map((index) => piece(String(index), "继续", index * 600)), piece("tail", "讲价", 4_000)],
      null,
      overlay,
    ).map((line) => line.text)).toEqual(["今天天气继续继续继续继续继续。", "讲价"]);
  });

  it("硬失败三次后暂停，字幕退回原文；加载中只延后", () => {
    const pass = new PunctuationPass(config({ everyNFinals: 1, intervalMs: 1_000 }));
    const finals = [piece("a", "无标点", 0), piece("b", "继续说", 600), piece("c", "还在说", 1_200)];
    let now = 0;
    for (const final of finals) {
      pass.noteFinal(final, now);
      const batch = pass.begin(now);
      expect(batch).not.toBeNull();
      pass.complete(response(batch!.text, false, "标点失败"));
      now += 1_000;
    }
    expect(pass.paused()).toBe(true);
    expect(pass.overlay()).toBeNull();
    expect(presentPunctuatedCaptions(finals, null, pass.overlay())).toEqual(presentCaptions(finals, null));

    const loading = new PunctuationPass(config({ everyNFinals: 1, maxConsecutiveFailures: 2 }));
    loading.noteFinal(piece("a", "等待模型", 0), 0);
    loading.begin(0);
    loading.complete(response("等待模型", false, "标点模型加载中"));
    expect(loading.paused()).toBe(false);
    expect(loading.millisecondsUntilDue(0)).toBe(4_000);
  });

  it("停播离线全文对不齐时保留实时结果", () => {
    const pass = new PunctuationPass(config({ everyNFinals: 1 }));
    const finals = [piece("a", "今天天气", 0), piece("b", "不错", 600)];
    pass.noteFinal(finals[0]!, 0);
    pass.begin(0);
    pass.complete(response("今天天气"));
    pass.noteFinal(finals[1]!, 10);
    pass.begin(10);
    pass.complete(response("不错。"));
    expect(pass.overlay()?.mode).toBe("realtime");
    expect(pass.commitOffline(finals, response("不是原文。", true, "", "offline"))).toBe(false);
    expect(pass.overlay()?.text).toBe("今天天气不错。");
    expect(pass.commitOffline(finals, response("今天天气不错。", true, "", "offline"))).toBe(true);
    expect(pass.overlay()?.mode).toBe("offline");
  });

  it("调度器按间隔调用，超时后退回并不改写调用方文本", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const events: Array<{ text: string | null; paused: boolean }> = [];
    const punctuator: DisplayPunctuator = {
      async punctuate(text, mode) {
        calls.push(`${mode}:${text}`);
        if (mode === "offline") return response(`${text}。`, true, "", "offline");
        return response(text.replace("不错", "不错。"));
      },
    };
    const scheduler = new DisplayPunctuationScheduler(
      config({ everyNFinals: 6, intervalMs: 4_000, requestTimeoutMs: 500, offlineTimeoutMs: 500 }),
      (overlay, paused) => events.push({ text: overlay?.text ?? null, paused }),
      () => punctuator,
    );
    scheduler.noteFinal(piece("a", "今天天气不错", 0));
    await vi.advanceTimersByTimeAsync(3_999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(["realtime:今天天气不错"]);
    expect(events.at(-1)?.text).toBe("今天天气不错。");
    await scheduler.finish([piece("a", "今天天气不错", 0), piece("b", "我们继续讲", 600)]);
    expect(calls.at(-1)).toBe("offline:今天天气不错我们继续讲");
    expect(events.at(-1)?.text).toBe("今天天气不错我们继续讲。");
    vi.useRealTimers();
  });
});
