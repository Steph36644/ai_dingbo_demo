export type DemoUtterance = {
  startMs: number;
  endMs: number;
  text: string;
};

/** 确定性口播脚本。模拟链路用它滚动字幕，不代表真实识别结果。 */
export const DEMO_UTTERANCES: readonly DemoUtterance[] = [
  { startMs: 0, endMs: 1_800, text: "大家好，欢迎来到今天的直播间。" },
  { startMs: 2_200, endMs: 4_600, text: "这款今天的活动价和到手价，我给你们算清楚。" },
  { startMs: 5_000, endMs: 7_600, text: "核心卖点是成分和专利，下单前可以看一下库存。" },
  { startMs: 8_000, endMs: 10_400, text: "有问题直接打在公屏上，我按这个框架继续讲。" },
  { startMs: 10_800, endMs: 13_200, text: "现在先把价格、卖点和拍下方式说完整。" },
] as const;

export function scriptCycleMs(utterances: readonly DemoUtterance[]): number {
  const last = utterances.reduce((max, item) => Math.max(max, item.endMs), 0);
  return last + 800;
}

export function utteranceActive(
  timeMs: number,
  utterances: readonly DemoUtterance[],
  loop: boolean,
): boolean {
  if (utterances.length === 0) return false;
  const cycle = scriptCycleMs(utterances);
  const local = loop && cycle > 0 ? timeMs % cycle : timeMs;
  return utterances.some((item) => local >= item.startMs && local < item.endMs);
}
