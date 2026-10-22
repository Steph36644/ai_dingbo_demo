import { existsSync } from "node:fs";
import path from "node:path";
import { desktopCapturer } from "electron";
import type { DeviceListResult } from "@shared/contracts/audio";
import { describeLoopback } from "./audio/platformCapability";
import { probeWasapiBridge } from "./audio/wasapiLoopback";

export async function listAudioDevices(): Promise<DeviceListResult> {
  const bridgePresent = existsSync(path.join(process.cwd(), "resources/native/wasapi.node"));
  const wasapi = probeWasapiBridge(bridgePresent);
  let screens: Array<{ id: string; name: string }> = [];
  let enumerateError: string | undefined;
  if (process.platform === "win32") {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      screens = sources.map((source) => ({ id: source.id, name: source.name }));
    } catch (error) {
      enumerateError = error instanceof Error ? error.message : String(error);
    }
  }
  return describeLoopback({
    platform: process.platform,
    screens,
    wasapi,
    enumerateError,
  });
}
