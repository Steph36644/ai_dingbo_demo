import type { DingboBridge } from "@shared/contracts/bridge";

export function issueRuleBridge(): DingboBridge | undefined {
  return typeof window === "undefined" ? undefined : (window as Window & { dingbo?: DingboBridge }).dingbo;
}
