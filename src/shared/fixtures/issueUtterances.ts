import type { DemoScriptId } from "../contracts/session";
import { DEMO_UTTERANCES, type DemoUtterance } from "./demoUtterances";

/**
 * 可注入的问题样例。正常口播脚本会覆盖全部必讲点，看不到漏讲和触雷。
 * 这一份故意留下价格/促单，命中「一定能 / 根治」，并留出 5 秒静音。
 */
export const ISSUE_UTTERANCES: readonly DemoUtterance[] = [
  { startMs: 0, endMs: 3_000, text: "大家好，欢迎来到今天的直播间。" },
  { startMs: 8_000, endMs: 12_000, text: "这个一定能根治，核心卖点先放一下。" },
] as const;

export function utterancesFor(options: {
  audioSource?: string;
  asrId?: string;
  demoScript?: DemoScriptId;
}): readonly DemoUtterance[] {
  if (options.audioSource === "simulated" && options.asrId === "fake" && options.demoScript === "issues") {
    return ISSUE_UTTERANCES;
  }
  return DEMO_UTTERANCES;
}
