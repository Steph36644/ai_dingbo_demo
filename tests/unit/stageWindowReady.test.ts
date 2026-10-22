import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { StageView } from "../../src/shared/contracts/stage";

const { screenOn, whenReadyHandlers } = vi.hoisted(() => {
  const whenReadyHandlers: Array<() => void> = [];
  const screenOn = vi.fn();
  return { screenOn, whenReadyHandlers };
});

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    whenReady: () =>
      new Promise<void>((resolve) => {
        whenReadyHandlers.push(resolve);
      }),
  },
  BrowserWindow: class BrowserWindow {},
  screen: {
    on: screenOn,
  },
}));

import { StageWindowManager } from "../../src/main/stage/StageWindowManager";

const emptyView: StageView = {
  sessionId: null,
  stageLabel: "未开播",
  unreadCount: 0,
  suggestion: null,
  health: "idle",
};

function createManager(onDisplayDisconnected = vi.fn()) {
  return new StageWindowManager({
    getControlWindow: () => null,
    getStageView: () => emptyView,
    getTranscript: () => ({
      sessionId: null,
      finals: [],
      partial: null,
      presentation: null,
    }),
    onStageClosed: () => undefined,
    onDisplayDisconnected,
    onLoadFailed: () => undefined,
  });
}

describe("StageWindowManager 与 app ready 的时序", () => {
  beforeEach(() => {
    screenOn.mockClear();
    whenReadyHandlers.length = 0;
  });

  it("构造函数不访问 screen，ready 之后才订阅显示器事件", async () => {
    createManager();
    expect(screenOn).not.toHaveBeenCalled();
    expect(whenReadyHandlers).toHaveLength(1);

    whenReadyHandlers[0]?.();
    await vi.waitFor(() => {
      expect(screenOn).toHaveBeenCalledWith("display-removed", expect.any(Function));
      expect(screenOn).toHaveBeenCalledWith("display-metrics-changed", expect.any(Function));
    });
  });

  it("ready 只订阅一次；未打开 Stage 时 display-removed 不通知断屏", async () => {
    const onDisplayDisconnected = vi.fn();
    const manager = createManager(onDisplayDisconnected);
    whenReadyHandlers[0]?.();
    await vi.waitFor(() => expect(screenOn).toHaveBeenCalledTimes(2));

    manager.attachDisplayListeners();
    expect(screenOn).toHaveBeenCalledTimes(2);

    const removed = screenOn.mock.calls.find((call) => call[0] === "display-removed")?.[1] as
      | ((event: unknown, display: { id: number }) => void)
      | undefined;
    removed?.({}, { id: 7 });
    expect(onDisplayDisconnected).not.toHaveBeenCalled();
  });

  it("主进程在 ready 之前构造 StageWindowManager，且源码里不提前点名 screen", () => {
    const source = readFileSync(new URL("../../src/main/index.ts", import.meta.url), "utf8");
    const readyAt = source.indexOf("app.whenReady()");
    const ctorAt = source.indexOf("new StageWindowManager");
    expect(ctorAt).toBeGreaterThan(-1);
    expect(readyAt).toBeGreaterThan(ctorAt);
    expect(source.slice(0, readyAt)).not.toMatch(/\bscreen\b/);
  });
});
