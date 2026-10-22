import { beforeEach, describe, expect, it, vi } from "vitest";
import { IpcChannels } from "../../src/shared/contracts/ipc";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn),
    on: vi.fn(),
  },
  app: { whenReady: () => Promise.resolve() },
  dialog: {},
  screen: {},
}));

import { registerIpc, type IpcRuntime } from "../../src/main/ipc";

/**
 * 对齐 StreamWindowManager.setVisible：窗口还在时，显示和隐藏成功都返回 true，
 * 返回值不是可见状态。旧的 IPC mock `(visible) => visible` 掩盖了这个差别。
 */
function managerShapedStreamWindows(initialVisible: boolean) {
  let visible = initialVisible;
  const setVisible = vi.fn((requested: boolean) => {
    visible = requested;
    return visible === requested;
  });
  return {
    contents: () => null,
    isVisible: () => visible,
    setVisible,
    setAudible: vi.fn(),
  };
}

function register(streamWindows: ReturnType<typeof managerShapedStreamWindows>) {
  const control = { mainFrame: {}, isDestroyed: () => false, send: vi.fn() };
  registerIpc({
    getWindow: () => ({ isDestroyed: () => false, webContents: control }),
    controller: {
      actions: { onChange: vi.fn() },
      getTranscript: () => ({ sessionId: "s", finals: [], partial: null }),
      stageView: () => ({ stageLabel: "直播中" }),
      snapshot: () => ({ state: "running" }),
      ingestChunk: vi.fn(),
      notifyCaptureFailed: vi.fn(),
      onState: vi.fn(),
      onTranscript: vi.fn(),
      onPresentation: vi.fn(),
      onLevel: vi.fn(),
      onIssues: vi.fn(),
      onCoverage: vi.fn(),
      onStage: vi.fn(),
    },
    stageManager: { contents: () => null },
    streamWindows,
    asr: {},
    frameworks: {},
    secrets: {},
    stagePreferences: {},
  } as unknown as IpcRuntime);
  return {
    control,
    get: handlers.get(IpcChannels.streamWindowGet)!,
    set: handlers.get(IpcChannels.streamWindowSet)!,
  };
}

describe("直播画面 IPC 可见状态", () => {
  beforeEach(() => {
    handlers.clear();
  });

  it("隐藏成功时 setVisible 返回 true，IPC 仍回报 visible: false", () => {
    const streamWindows = managerShapedStreamWindows(true);
    const { control, set } = register(streamWindows);
    const event = { sender: control, senderFrame: control.mainFrame };

    const result = set(event, { visible: false });

    expect(streamWindows.setVisible).toHaveReturnedWith(true);
    expect(result).toEqual({ ok: true, visible: false });
    expect(streamWindows.isVisible()).toBe(false);
  });

  it("显示成功时回报 visible: true", () => {
    const streamWindows = managerShapedStreamWindows(false);
    const { control, get, set } = register(streamWindows);
    const event = { sender: control, senderFrame: control.mainFrame };

    expect(set(event, { visible: true })).toEqual({ ok: true, visible: true });
    expect(streamWindows.setVisible).toHaveReturnedWith(true);
    expect(get(event)).toEqual({ visible: true });
  });

  it("参数不是布尔时不调用 setVisible，并回报当前可见状态", () => {
    const streamWindows = managerShapedStreamWindows(true);
    const { control, set } = register(streamWindows);
    const event = { sender: control, senderFrame: control.mainFrame };

    expect(set(event, {})).toEqual({ ok: false, visible: true });
    expect(set(event, { visible: "false" })).toEqual({ ok: false, visible: true });
    expect(streamWindows.setVisible).not.toHaveBeenCalled();
  });
});
