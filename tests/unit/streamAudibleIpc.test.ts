import { afterEach, describe, expect, it, vi } from "vitest";
import { IpcChannels } from "../../src/shared/contracts/ipc";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: any[]) => any) => {
      handlers.set(name, fn);
    },
    on: vi.fn(),
  },
  app: { whenReady: () => Promise.resolve() },
  dialog: {},
  screen: {},
  desktopCapturer: {},
}));

import { registerIpc, type IpcRuntime } from "../../src/main/ipc";
import { currentSettings, resetAnalysisSettings } from "../../src/main/settings";

afterEach(() => {
  resetAnalysisSettings();
  handlers.clear();
});

function register(state: string, setAudible: (audible: boolean) => void) {
  const control = { mainFrame: {}, isDestroyed: () => false, send: vi.fn() };
  registerIpc({
    getWindow: () => ({ isDestroyed: () => false, webContents: control }),
    controller: {
      actions: { onChange: vi.fn() },
      getTranscript: () => ({ sessionId: "s", finals: [], partial: null }),
      stageView: () => ({ stageLabel: "直播中" }),
      snapshot: () => ({ state }),
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
    streamWindows: {
      contents: () => null,
      isVisible: () => false,
      setVisible: (visible: boolean) => visible,
      setAudible,
    },
    asr: {},
    frameworks: {},
    secrets: {},
    stagePreferences: {},
  } as unknown as IpcRuntime);
  return { control, update: handlers.get(IpcChannels.settingsUpdate)! };
}

describe("直播流外放与静音联动", () => {
  it("打开外放时 setAudible(true)，关闭时 setAudible(false)", () => {
    const setAudible = vi.fn();
    const { control, update } = register("idle", setAudible);
    const event = { sender: control, senderFrame: control.mainFrame };

    expect(currentSettings().streamAudible).toBe(false);
    expect(update(event, { streamAudible: true })).toMatchObject({
      ok: true,
      settings: { streamAudible: true },
    });
    expect(setAudible).toHaveBeenCalledWith(true);

    expect(update(event, { streamAudible: false })).toMatchObject({
      ok: true,
      settings: { streamAudible: false },
    });
    expect(setAudible).toHaveBeenLastCalledWith(false);
  });

  it("盯播中不能改窗口和间隔，但仍可开关外放并通知直播窗", () => {
    const setAudible = vi.fn();
    const { control, update } = register("running", setAudible);
    const event = { sender: control, senderFrame: control.mainFrame };

    expect(update(event, { windowMs: 120_000, intervalMs: 30_000, streamAudible: true })).toMatchObject({
      ok: false,
      code: "session_active",
    });
    expect(setAudible).not.toHaveBeenCalled();
    expect(currentSettings().streamAudible).toBe(false);

    expect(update(event, { streamAudible: true }).ok).toBe(true);
    expect(setAudible).toHaveBeenCalledWith(true);
    expect(currentSettings()).toMatchObject({ windowMs: 300_000, intervalMs: 60_000, streamAudible: true });
  });

  it("只改窗口和间隔时，仍按当前外放状态套到直播窗", () => {
    const setAudible = vi.fn();
    const { control, update } = register("idle", setAudible);
    const saved = update({ sender: control, senderFrame: control.mainFrame }, { windowMs: 120_000, intervalMs: 30_000 });
    expect(saved.ok).toBe(true);
    expect(setAudible).toHaveBeenCalledWith(false);
  });
});
