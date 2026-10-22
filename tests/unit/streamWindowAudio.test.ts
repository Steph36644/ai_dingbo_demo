import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeContents = {
  setAudioMuted: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
};

type FakeWindow = {
  options: Record<string, unknown>;
  webContents: FakeContents;
  loadURL: ReturnType<typeof vi.fn>;
  destroyed: boolean;
  isDestroyed: () => boolean;
  destroy: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  setFocusable: ReturnType<typeof vi.fn>;
  setAlwaysOnTop: ReturnType<typeof vi.fn>;
  setSkipTaskbar: ReturnType<typeof vi.fn>;
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
  setOpacity: ReturnType<typeof vi.fn>;
  setHasShadow: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
  getBounds: ReturnType<typeof vi.fn>;
  setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
};

const { created, getDisplayMatching } = vi.hoisted(() => ({
  created: [] as FakeWindow[],
  getDisplayMatching: vi.fn(() => ({ workArea: { x: 1920, y: 0, width: 1440, height: 900 } })),
}));

vi.mock("electron", () => {
  class BrowserWindow {
    destroyed = false;
    options: Record<string, unknown>;
    webContents: FakeContents;
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
    loadURL = vi.fn(() => Promise.resolve());
    on = vi.fn();
    setFocusable = vi.fn();
    setAlwaysOnTop = vi.fn();
    setSkipTaskbar = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    setOpacity = vi.fn();
    setHasShadow = vi.fn();
    setBounds = vi.fn();
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: 480, height: 800 }));
    setVisibleOnAllWorkspaces = vi.fn();
    show = vi.fn();
    showInactive = vi.fn();
    hide = vi.fn();
    isDestroyed(): boolean {
      return this.destroyed;
    }
    constructor(options?: Record<string, unknown>) {
      this.options = options ?? {};
      this.webContents = {
        setAudioMuted: vi.fn(),
        on: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        isDestroyed: () => this.destroyed,
      };
      created.push(this as unknown as FakeWindow);
    }
  }
  return {
    BrowserWindow,
    screen: { getDisplayMatching },
    app: {},
    session: { defaultSession: {} },
    desktopCapturer: {},
    dialog: {},
  };
});

import { STREAM_CAPTURE_STALL_MESSAGE } from "../../src/shared/audio/streamCapture";
import { StreamWindowManager } from "../../src/main/audio/streamWindow";

const LIVE = "https://live.douyin.com/1";

describe("直播流扬声器", () => {
  beforeEach(() => {
    created.length = 0;
    getDisplayMatching.mockClear();
  });

  it("默认不外放：打开直播窗时 setAudioMuted(true)，且早于加载页面", () => {
    const manager = new StreamWindowManager({ preloadPath: "preload.js" });
    manager.open("s", LIVE);
    const win = created[0];
    if (!win) throw new Error("直播窗没有创建");
    expect(win.webContents.setAudioMuted).toHaveBeenCalledTimes(1);
    expect(win.webContents.setAudioMuted).toHaveBeenCalledWith(true);
    const mutedAt = win.webContents.setAudioMuted.mock.invocationCallOrder[0] ?? 0;
    const loadedAt = win.loadURL.mock.invocationCallOrder[0] ?? 0;
    expect(mutedAt).toBeGreaterThan(0);
    expect(mutedAt).toBeLessThan(loadedAt);
  });

  it("外放开时 setAudioMuted(false)，显示或隐藏画面不再改静音", () => {
    const manager = new StreamWindowManager({ preloadPath: "preload.js", audible: () => true });
    manager.open("s", LIVE);
    const win = created[0];
    expect(win?.webContents.setAudioMuted).toHaveBeenCalledTimes(1);
    expect(win?.webContents.setAudioMuted).toHaveBeenCalledWith(false);
    expect(manager.setVisible(false)).toBe(true);
    manager.reveal();
    expect(manager.setVisible(true)).toBe(true);
    expect(win?.webContents.setAudioMuted).toHaveBeenCalledTimes(1);
    expect(win?.showInactive).toHaveBeenCalled();
    expect(win?.show).toHaveBeenCalled();
  });

  it("外放开关立刻改该窗静音，隐藏画面时也生效", () => {
    let audible = false;
    const manager = new StreamWindowManager({ preloadPath: "preload.js", audible: () => audible });
    manager.open("s", LIVE);
    const win = created[0];
    expect(manager.setVisible(false)).toBe(true);
    expect(win?.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);

    audible = true;
    manager.setAudible(true);
    expect(win?.webContents.setAudioMuted).toHaveBeenLastCalledWith(false);

    manager.setAudible(false);
    expect(win?.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
    expect(win?.show).not.toHaveBeenCalled();
  });

  it("重载时按当前外放设置再次静音，仍早于 loadURL", () => {
    let audible = false;
    const manager = new StreamWindowManager({ preloadPath: "preload.js", audible: () => audible });
    manager.open("s", LIVE);
    const win = created[0];
    audible = true;
    manager.reload();
    const mutes = win?.webContents.setAudioMuted.mock.invocationCallOrder ?? [];
    const loads = win?.loadURL.mock.invocationCallOrder ?? [];
    expect(win?.webContents.setAudioMuted).toHaveBeenLastCalledWith(false);
    expect(mutes).toHaveLength(2);
    expect(loads).toHaveLength(2);
    expect(mutes[0] ?? 0).toBeLessThan(loads[0] ?? 0);
    expect(mutes[1] ?? 0).toBeLessThan(loads[1] ?? 0);
  });

  it("导航开始时再次套用静音", () => {
    const manager = new StreamWindowManager({ preloadPath: "preload.js", audible: () => false });
    manager.open("s", LIVE);
    const win = created[0];
    const nav = win?.webContents.on.mock.calls.find((call) => call[0] === "did-start-navigation")?.[1] as
      | (() => void)
      | undefined;
    expect(nav).toBeTypeOf("function");
    nav?.();
    expect(win?.webContents.setAudioMuted).toHaveBeenCalledTimes(2);
    expect(win?.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
  });
});

function controlWindow() {
  return {
    isDestroyed: () => false,
    getBounds: () => ({ x: 2100, y: 40, width: 1180, height: 920 }),
  };
}

describe("macOS 直播窗不切 Space", () => {
  beforeEach(() => {
    created.length = 0;
    getDisplayMatching.mockReset();
    getDisplayMatching.mockImplementation(() => ({ workArea: { x: 1920, y: 0, width: 1440, height: 900 } }));
  });

  it("隐藏采集用 panel、showInactive 和 opacity 0，不用 screen-saver 置顶，也不自动 show", () => {
    const onCaptureStalled = vi.fn();
    const manager = new StreamWindowManager({
      preloadPath: "preload.js",
      platform: "darwin",
      getControlWindow: () => controlWindow() as never,
      onCaptureStalled,
    });
    manager.open("s", LIVE);
    const win = created[0];
    expect(win?.options.type).toBe("panel");
    expect(win?.options.fullscreenable).toBe(false);
    expect(win?.options.opacity).toBe(0);
    expect(win?.options.show).toBe(false);
    expect(win?.setAlwaysOnTop).toHaveBeenCalledWith(false);
    expect(win?.setAlwaysOnTop).not.toHaveBeenCalledWith(true, "screen-saver");
    expect(win?.showInactive).toHaveBeenCalled();
    expect(win?.show).not.toHaveBeenCalled();
    expect(win?.setOpacity).toHaveBeenLastCalledWith(0);
    expect(win?.setHasShadow).toHaveBeenLastCalledWith(false);
    expect(win?.setVisibleOnAllWorkspaces).not.toHaveBeenCalled();
    expect(manager.isVisible()).toBe(false);

    manager.reveal();
    manager.reveal();
    expect(win?.show).not.toHaveBeenCalled();
    expect(win?.setOpacity).toHaveBeenLastCalledWith(0);
    expect(manager.isVisible()).toBe(false);
    expect(onCaptureStalled).toHaveBeenCalledOnce();
    expect(onCaptureStalled).toHaveBeenCalledWith({ message: STREAM_CAPTURE_STALL_MESSAGE });
  });

  it("用户点显示画面时先对齐控制窗的显示器和当前 Space，再 show", () => {
    const manager = new StreamWindowManager({
      preloadPath: "preload.js",
      platform: "darwin",
      getControlWindow: () => controlWindow() as never,
    });
    manager.open("s", LIVE);
    const win = created[0];
    expect(manager.setVisible(true)).toBe(true);
    expect(getDisplayMatching).toHaveBeenCalledWith({ x: 2100, y: 40, width: 1180, height: 920 });
    expect(win?.setBounds).toHaveBeenCalledWith({
      x: 1920 + Math.round((1440 - 480) / 2),
      y: Math.round((900 - 800) / 2),
      width: 480,
      height: 800,
    });
    expect(win?.setVisibleOnAllWorkspaces).toHaveBeenNthCalledWith(1, true, {
      visibleOnFullScreen: false,
      skipTransformProcessType: true,
    });
    expect(win?.setVisibleOnAllWorkspaces).toHaveBeenNthCalledWith(2, false, {
      skipTransformProcessType: true,
    });
    expect(win?.setOpacity).toHaveBeenLastCalledWith(1);
    expect(win?.setHasShadow).toHaveBeenLastCalledWith(true);
    expect(win?.show).toHaveBeenCalledOnce();
    const alignAt = win?.setBounds.mock.invocationCallOrder[0] ?? 0;
    const shownAt = win?.show.mock.invocationCallOrder[0] ?? 0;
    expect(alignAt).toBeGreaterThan(0);
    expect(alignAt).toBeLessThan(shownAt);
    expect(manager.isVisible()).toBe(true);

    const pulses = win?.setVisibleOnAllWorkspaces.mock.calls.length ?? 0;
    expect(manager.setVisible(false)).toBe(true);
    expect(win?.showInactive).toHaveBeenCalled();
    expect(win?.setOpacity).toHaveBeenLastCalledWith(0);
    expect(win?.setVisibleOnAllWorkspaces).toHaveBeenCalledTimes(pulses);
    expect(manager.isVisible()).toBe(false);
  });

  it("对齐失败仍然显示，没有控制窗时不查显示器", () => {
    getDisplayMatching.mockImplementation(() => {
      throw new Error("screen unavailable");
    });
    const manager = new StreamWindowManager({
      preloadPath: "preload.js",
      platform: "darwin",
      getControlWindow: () => controlWindow() as never,
    });
    manager.open("s", LIVE);
    expect(manager.setVisible(true)).toBe(true);
    expect(created[0]?.show).toHaveBeenCalledOnce();

    const bare = new StreamWindowManager({ preloadPath: "preload.js", platform: "darwin" });
    bare.open("s2", LIVE);
    getDisplayMatching.mockClear();
    expect(bare.setVisible(true)).toBe(true);
    expect(getDisplayMatching).not.toHaveBeenCalled();
    expect(created[1]?.show).toHaveBeenCalledOnce();
  });
});

describe("Windows 直播窗保持原路径", () => {
  beforeEach(() => {
    created.length = 0;
    getDisplayMatching.mockClear();
  });

  it("隐藏时 screen-saver 置顶，超时 reveal 会 show，不发 Mac 提示", () => {
    const onCaptureStalled = vi.fn();
    const manager = new StreamWindowManager({
      preloadPath: "preload.js",
      platform: "win32",
      getControlWindow: () => controlWindow() as never,
      onCaptureStalled,
    });
    manager.open("s", LIVE);
    const win = created[0];
    expect(win?.options.type).toBeUndefined();
    expect(win?.options.fullscreenable).toBeUndefined();
    expect(win?.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
    expect(win?.showInactive).toHaveBeenCalled();
    expect(win?.show).not.toHaveBeenCalled();

    manager.reveal();
    expect(onCaptureStalled).not.toHaveBeenCalled();
    expect(win?.show).toHaveBeenCalledOnce();
    expect(win?.setOpacity).toHaveBeenLastCalledWith(1);
    expect(win?.setAlwaysOnTop).toHaveBeenLastCalledWith(false, "screen-saver");
    expect(win?.setVisibleOnAllWorkspaces).not.toHaveBeenCalled();
    expect(getDisplayMatching).not.toHaveBeenCalled();
    expect(manager.isVisible()).toBe(true);
  });
});

describe("关闭直播窗只隐藏", () => {
  beforeEach(() => {
    created.length = 0;
    getDisplayMatching.mockReset();
    getDisplayMatching.mockImplementation(() => ({ workArea: { x: 1920, y: 0, width: 1440, height: 900 } }));
  });

  it.each(["darwin", "win32"] as const)("%s：可见时点关闭回到隐藏采集，manager.close() 才销毁", (platform) => {
    const onUserHid = vi.fn();
    const manager = new StreamWindowManager({ preloadPath: "preload.js", platform, onUserHid });
    manager.open("s", LIVE);
    const win = created[0];
    if (!win) throw new Error("直播窗没有创建");
    expect(manager.setVisible(true)).toBe(true);

    const close = win.on.mock.calls.find((call) => call[0] === "close")?.[1] as
      | ((event: { preventDefault: () => void }) => void)
      | undefined;
    expect(close).toBeTypeOf("function");
    const event = { preventDefault: vi.fn() };
    close?.(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(win.destroy).not.toHaveBeenCalled();
    expect(win.isDestroyed()).toBe(false);
    expect(win.hide).not.toHaveBeenCalled();
    expect(manager.isVisible()).toBe(false);
    expect(manager.contents()).toBe(win.webContents);
    expect(win.setOpacity).toHaveBeenLastCalledWith(0);
    expect(win.showInactive.mock.invocationCallOrder.at(-1) ?? 0).toBeGreaterThan(win.show.mock.invocationCallOrder.at(-1) ?? 0);
    expect(onUserHid).toHaveBeenCalledOnce();
    if (platform === "win32") expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(true, "screen-saver");
    if (platform === "darwin") {
      expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
      expect(win.setHasShadow).toHaveBeenLastCalledWith(false);
    }

    manager.close();
    expect(win.destroy).toHaveBeenCalledOnce();
    expect(win.isDestroyed()).toBe(true);
    expect(manager.isVisible()).toBe(false);
    expect(manager.contents()).toBeNull();
  });
});
