import { describe, expect, it } from "vitest";
import {
  WORKSPACES,
  dockStorageKey,
  readDockCollapsed,
  writeDockCollapsed,
} from "../../src/renderer/app/shell/workspace";

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

describe("工作区与 dock 折叠", () => {
  it("工作区固定为 盯播 / 回看 / 设置", () => {
    expect(WORKSPACES.map((item) => item.id)).toEqual(["monitor", "replay", "settings"]);
    expect(WORKSPACES.map((item) => item.label)).toEqual(["盯播", "回看", "设置"]);
  });

  it("折叠状态的存储键带工作区前缀，互不串味", () => {
    expect(dockStorageKey("monitor", "issues")).toBe("dingbo.dock.monitor.issues");
    expect(dockStorageKey("replay", "issues")).not.toBe(dockStorageKey("monitor", "issues"));
  });

  it("默认展开，写入 1 后折叠，写入 0 后恢复", () => {
    const storage = fakeStorage();
    expect(readDockCollapsed(storage, "monitor", "sources")).toBe(false);
    writeDockCollapsed(storage, "monitor", "sources", true);
    expect(readDockCollapsed(storage, "monitor", "sources")).toBe(true);
    writeDockCollapsed(storage, "monitor", "sources", false);
    expect(readDockCollapsed(storage, "monitor", "sources")).toBe(false);
  });

  it("存储不可用或抛错时按展开处理，不影响渲染", () => {
    expect(readDockCollapsed(null, "monitor", "issues")).toBe(false);
    expect(() => writeDockCollapsed(null, "monitor", "issues", true)).not.toThrow();
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readDockCollapsed(throwing, "monitor", "issues")).toBe(false);
    expect(() => writeDockCollapsed(throwing, "monitor", "issues", true)).not.toThrow();
  });
});
