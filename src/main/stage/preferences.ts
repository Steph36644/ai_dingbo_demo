import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StagePreferences } from "@shared/contracts/display";

const FILE_NAME = "stage-preferences.json";
const DEFAULT_PREFERENCES: StagePreferences = { displayId: null, mode: "window" };

/** 抬头屏显示偏好。读写失败一律回退默认值，不阻断开会话。 */
export class StagePreferencesStore {
  private current: StagePreferences = { ...DEFAULT_PREFERENCES };

  constructor(private readonly dir: string) {
    this.current = this.load();
  }

  read(): StagePreferences {
    return { ...this.current };
  }

  write(next: StagePreferences): StagePreferences {
    this.current = { displayId: next.displayId, mode: next.mode };
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, FILE_NAME), `${JSON.stringify({ schemaVersion: 1, ...this.current }, null, 2)}\n`, "utf8");
    } catch {
      // 写入失败只影响下次默认选中，不影响本场。
    }
    return this.read();
  }

  private load(): StagePreferences {
    const path = join(this.dir, FILE_NAME);
    if (!existsSync(path)) return { ...DEFAULT_PREFERENCES };
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!raw || typeof raw !== "object") return { ...DEFAULT_PREFERENCES };
      const value = raw as { displayId?: unknown; mode?: unknown };
      return {
        displayId: typeof value.displayId === "number" && Number.isInteger(value.displayId) ? value.displayId : null,
        mode: value.mode === "fullscreen" ? "fullscreen" : "window",
      };
    } catch {
      return { ...DEFAULT_PREFERENCES };
    }
  }
}
