export function formatClock(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export const STATE_LABEL: Record<string, string> = {
  idle: "未开始",
  preparing: "准备中",
  running: "盯播中",
  degraded: "已降级",
  stopping: "停止中",
  completed: "已结束",
  error: "出错",
};
