import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StagePreferencesStore } from "../../src/main/stage/preferences";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dingbo-stage-prefs-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  tempDirs.length = 0;
});

describe("抬头屏显示偏好", () => {
  it("首次启动没有文件时回退主屏 + 窗口模式", () => {
    const store = new StagePreferencesStore(tempDir());
    expect(store.read()).toEqual({ displayId: null, mode: "window" });
  });

  it("写入后能读回，且返回拷贝不暴露内部状态", () => {
    const dir = tempDir();
    const store = new StagePreferencesStore(dir);
    expect(store.write({ displayId: 2, mode: "fullscreen" })).toEqual({ displayId: 2, mode: "fullscreen" });

    const read = store.read();
    read.displayId = 99;
    expect(store.read().displayId).toBe(2);

    const reopened = new StagePreferencesStore(dir);
    expect(reopened.read()).toEqual({ displayId: 2, mode: "fullscreen" });
  });

  it("文件损坏或字段非法时逐项回退，不抛错", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "stage-preferences.json"), "{ not json", "utf8");
    expect(new StagePreferencesStore(dir).read()).toEqual({ displayId: null, mode: "window" });

    const dir2 = tempDir();
    writeFileSync(
      path.join(dir2, "stage-preferences.json"),
      JSON.stringify({ schemaVersion: 1, displayId: "2", mode: "kiosk" }),
      "utf8",
    );
    expect(new StagePreferencesStore(dir2).read()).toEqual({ displayId: null, mode: "window" });

    const dir3 = tempDir();
    writeFileSync(
      path.join(dir3, "stage-preferences.json"),
      JSON.stringify({ schemaVersion: 1, displayId: 1.5, mode: "fullscreen" }),
      "utf8",
    );
    expect(new StagePreferencesStore(dir3).read()).toEqual({ displayId: null, mode: "fullscreen" });
  });
});
