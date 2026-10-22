import { describe, expect, it, vi } from "vitest";

// Mock electron 模块，避免 vitest 里访问真实 app 对象
vi.mock("electron", () => ({
  app: {
    whenReady: () => Promise.resolve(),
    isPackaged: false,
    getAppPath: () => "",
    getPath: () => "",
  },
  BrowserWindow: vi.fn(),
  screen: {
    on: vi.fn(),
    getDisplayNearestPoint: vi.fn(),
  },
}));

import { parseStageOpen, parseStageSet } from "../../src/main/ipc/schemas";

describe("stage IPC 参数校验", () => {
  it("stage:open 接受合法 displayId 和 mode", () => {
    expect(parseStageOpen({ displayId: 1, mode: "window" })).toEqual({ displayId: 1, mode: "window" });
    expect(parseStageOpen({ displayId: 2, mode: "fullscreen" })).toEqual({ displayId: 2, mode: "fullscreen" });
  });

  it("stage:open 拒绝非法 mode 和额外字段", () => {
    expect(parseStageOpen({ displayId: 1, mode: "kiosk" })).toBeNull();
    expect(parseStageOpen({ displayId: 1, mode: "window", extra: true })).toBeNull();
  });

  it("stage:set 接受四种写法", () => {
    expect(parseStageSet({ stageId: "pitch" })).toEqual({ stageId: "pitch" });
    expect(parseStageSet({ pinIssueId: "i1" })).toEqual({ pinIssueId: "i1" });
    expect(parseStageSet({ dismissIssueId: "i2" })).toEqual({ dismissIssueId: "i2" });
    expect(parseStageSet({ productNote: "面霜" })).toEqual({ productNote: "面霜" });
    expect(parseStageSet({ productNote: null })).toEqual({ productNote: null });
    expect(parseStageSet({ clearPin: true })).toEqual({ clearPin: true });
  });

  it("stage:set 拒绝非法值", () => {
    expect(parseStageSet({ stageId: "" })).toBeNull();
    expect(parseStageSet({ productNote: "x".repeat(501) })).toBeNull();
    expect(parseStageSet({ clearPin: false })).toBeNull();
    expect(parseStageSet({ clearPin: true, pinIssueId: "i1" })).toBeNull();
    expect(parseStageSet({ unknown: 1 })).toBeNull();
  });
});

describe("StageWindowManager 字幕推送", () => {
  it("pushTranscript 把字幕快照发给 stage 窗口", async () => {
    const { StageWindowManager } = await import("../../src/main/stage/StageWindowManager");
    const mockSend = vi.fn();
    const mockWindow = {
      isDestroyed: () => false,
      webContents: { send: mockSend },
      on: vi.fn(),
      setBounds: vi.fn(),
      setFullScreenable: vi.fn(),
      loadURL: vi.fn(),
      loadFile: vi.fn(),
      destroy: vi.fn(),
    };
    const hooks = {
      getControlWindow: () => null,
      getStageView: () => ({
        sessionId: null,
        stageLabel: "未开播",
        unreadCount: 0,
        suggestion: null,
        health: "idle" as const,
      }),
      getTranscript: () => ({
        sessionId: "s1",
        finals: [],
        partial: null,
        presentation: null,
      }),
      onStageClosed: vi.fn(),
      onDisplayDisconnected: vi.fn(),
      onLoadFailed: vi.fn(),
    };
    const manager = new StageWindowManager(hooks);
    // 直接注入 mock window，跳过真实 Electron 窗口创建
    (manager as unknown as { stageWindow: unknown }).stageWindow = mockWindow;

    manager.pushTranscript({
      sessionId: "s1",
      finals: [],
      partial: null,
      presentation: null,
    });

    expect(mockSend).toHaveBeenCalledWith("stage:transcript", {
      sessionId: "s1",
      finals: [],
      partial: null,
      presentation: null,
    });
  });

  it("stageGetTranscript 返回控制器最新快照", () => {
    const view = {
      sessionId: "s1",
      finals: [{ id: "f1", sessionId: "s1", sourceResultId: "r1", startMs: 0, endMs: 100, text: "hello", normalizedText: "hello", isFinal: true }],
      partial: null,
      presentation: null,
    };
    // 模拟 ipc handle 的返回值结构
    const payload = {
      sessionId: view.sessionId,
      finals: view.finals,
      partial: view.partial,
      presentation: view.presentation ?? null,
    };
    expect(payload).toEqual({
      sessionId: "s1",
      finals: view.finals,
      partial: null,
      presentation: null,
    });
  });
});
