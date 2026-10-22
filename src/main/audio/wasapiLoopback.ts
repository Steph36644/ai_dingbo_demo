import type { WasapiProbe } from "@shared/contracts/audio";

/**
 * Windows 优先路径是 WASAPI loopback 原生桥接。M1 不打包、不加载该模块，
 * 调用方应继续走 Electron desktopCapturer，而不是把探测失败当成已经采到声音。
 */
export function probeWasapiBridge(bridgePresent: boolean): WasapiProbe {
  if (!bridgePresent) {
    return {
      available: false,
      reason: "未打包 WASAPI 原生桥接（resources/native/wasapi.node）。Windows 回退到 Electron desktopCapturer 系统环回。",
    };
  }
  return {
    available: false,
    reason: "检测到 wasapi.node，但 M1 尚未加载原生模块，不会把它当成可用环回。",
  };
}
