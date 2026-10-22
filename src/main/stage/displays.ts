import { screen, type Display } from "electron";
import type { DisplayInfo } from "../../shared/contracts/display";

/** 把 Electron Display 白名单化成可进 IPC 的 DisplayInfo。 */
export function toDisplayInfo(display: Display): DisplayInfo {
  return {
    id: display.id,
    bounds: { ...display.bounds },
    workArea: { ...display.workArea },
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
    internal: display.internal,
  };
}

export function listDisplays(): DisplayInfo[] {
  return screen.getAllDisplays().map(toDisplayInfo);
}

export function findDisplay(id: number): Display | null {
  return screen.getAllDisplays().find((display) => display.id === id) ?? null;
}

export function primaryDisplay(): Display {
  return screen.getPrimaryDisplay();
}
