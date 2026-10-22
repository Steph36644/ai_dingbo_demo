import { describe, expect, it } from "vitest";
import { WindowScheduler, type AnalysisRequest } from "../../src/main/analysis/WindowScheduler";

describe("WindowScheduler", () => {
  it("满窗之前不分析，重入时跳过而不是并行", () => {
    const calls: AnalysisRequest[] = [];
    let overruns = 0;
    const scheduler = new WindowScheduler({
      getWindowMs: () => 60_000,
      getIntervalMs: () => 60_000,
      onAnalyze: (request) => {
        calls.push(request);
        if (calls.length === 1) scheduler.tick(180_000);
      },
      onOverrun: () => {
        overruns += 1;
      },
    });
    scheduler.start();
    scheduler.tick(59_999);
    expect(calls).toHaveLength(0);
    scheduler.tick(60_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ endMs: 60_000, windowMs: 60_000, finalFlush: false, scheduledAtMs: 60_000 });
    expect(overruns).toBe(1);
    scheduler.tick(180_000);
    expect(calls).toHaveLength(1);
    scheduler.tick(240_000);
    expect(calls).toHaveLength(2);
    scheduler.stop();
    scheduler.tick(400_000);
    expect(calls).toHaveLength(2);
  });

  it("停止后的补跑带 finalFlush，时钟为 0 时不跑", () => {
    const calls: AnalysisRequest[] = [];
    const scheduler = new WindowScheduler({
      getWindowMs: () => 60_000,
      getIntervalMs: () => 15_000,
      onAnalyze: (request) => calls.push(request),
      onOverrun: () => undefined,
    });
    scheduler.start();
    scheduler.stop();
    scheduler.finalFlush(0);
    scheduler.finalFlush(12_000);
    expect(calls).toEqual([
      expect.objectContaining({ endMs: 12_000, finalFlush: true, windowMs: 60_000 }),
    ]);
  });
});
