import type { DingboBridge } from "@shared/contracts/bridge";

declare global {
  interface Window {
    dingbo?: DingboBridge;
  }
}

export {};
