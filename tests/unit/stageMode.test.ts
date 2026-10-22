import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { whenReady: () => Promise.resolve(), isPackaged: false, getAppPath: () => "" },
  BrowserWindow: class BrowserWindow {},
  screen: { on: vi.fn() },
}));

import { StageWindowManager } from "../../src/main/stage/StageWindowManager";

function manager(): StageWindowManager {
  return new StageWindowManager({
    getControlWindow: () => null,
    getStageView: () => ({ sessionId: null, stageLabel: "未开播", unreadCount: 0, suggestion: null, health: "idle" }),
    getTranscript: () => ({ sessionId: null, finals: [], partial: null, presentation: null }),
    onStageClosed: () => undefined,
    onDisplayDisconnected: () => undefined,
    onLoadFailed: () => undefined,
  });
}

describe("抬头屏模式", () => {
  it("窗口模式与全屏模式都把 surface/mode 带进 URL", () => {
    const stage = manager() as unknown as { stageUrl: (mode: "window" | "fullscreen") => string };
    for (const mode of ["window", "fullscreen"] as const) {
      const url = stage.stageUrl(mode);
      expect(url).toContain("surface=stage");
      expect(url).toContain(`mode=${mode}`);
    }
    expect(stage.stageUrl("window")).toContain("?");
  });
});
