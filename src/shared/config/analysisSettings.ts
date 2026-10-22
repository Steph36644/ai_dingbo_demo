import { ANALYSIS_DEFAULTS } from "./defaults";

export type AnalysisTiming = {
  windowMs: number;
  intervalMs: number;
};

export function parseAnalysisSettings(input: {
  windowMs: unknown;
  intervalMs: unknown;
}): { ok: true; windowMs: number; intervalMs: number } | { ok: false; message: string } {
  const { windowMs, intervalMs } = input;
  if (typeof windowMs !== "number" || !Number.isInteger(windowMs)) {
    return { ok: false, message: "分析窗口必须是整数毫秒。" };
  }
  const [windowMin, windowMax] = ANALYSIS_DEFAULTS.windowMsRange;
  if (windowMs < windowMin || windowMs > windowMax) {
    return { ok: false, message: `分析窗口需在 ${windowMin}–${windowMax} 毫秒之间。` };
  }
  if (typeof intervalMs !== "number" || !Number.isInteger(intervalMs)) {
    return { ok: false, message: "分析间隔必须是整数毫秒。" };
  }
  const [intervalMin, intervalMax] = ANALYSIS_DEFAULTS.intervalMsRange;
  if (intervalMs < intervalMin || intervalMs > intervalMax) {
    return { ok: false, message: `分析间隔需在 ${intervalMin}–${intervalMax} 毫秒之间。` };
  }
  return { ok: true, windowMs, intervalMs };
}
