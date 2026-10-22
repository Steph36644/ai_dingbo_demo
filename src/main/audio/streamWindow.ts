import { BrowserWindow, screen, type WebContents } from "electron";
import {
  STREAM_CAPTURE_STALL_MESSAGE,
  streamBrowserWindowType,
  streamSpeakerMuted,
  streamWindowBoundsOnDisplay,
  streamWindowMode,
} from "@shared/audio/streamCapture";
import { markRelaxedContents } from "../app";
import { logEvent } from "../security/log";

const WINDOW_TITLE = "AI盯播 · 抖音直播流";

export type StreamWindowOptions = {
  preloadPath: string;
  audible?: () => boolean;
  /** 测试注入。缺省是当前进程平台。 */
  platform?: NodeJS.Platform;
  /** 用户点「显示画面」前，把直播窗挪到控制窗所在的显示器。 */
  getControlWindow?: () => BrowserWindow | null;
  /**
   * macOS 长时间没有首帧时调用。不要在这里 show() 直播窗。
   * Windows 仍走 reveal() → applyMode(true)。
   */
  onCaptureStalled?: (notice: { message: string }) => void;
  /** 用户点了系统关闭按钮，窗口回到隐藏采集，没有销毁。 */
  onUserHid?: () => void;
};

/**
 * 直播流隐藏播放窗。只加载规范化后的直播间 URL，只允许 douyin.com 导航；
 * 不向远程页面暴露 bridge，并把这个窗口的 webSecurity 关闭限制在独立分区内。
 */
export class StreamWindowManager {
  private window: BrowserWindow | null = null;
  private url = "";
  private visible = false;
  /** 本窗是否外放。默认关。与画面是否可见无关。 */
  private audible = false;
  /** 同一次打开里，首帧超时只提示一次。 */
  private stalledNotified = false;
  /** manager.close() 正在 destroy。这时不要把关闭拦成隐藏。 */
  private releasing = false;

  constructor(private readonly options: StreamWindowOptions) {}

  open(_sessionId: string, url: string): void {
    this.close();
    this.url = url;
    this.audible = this.options.audible?.() ?? this.audible;
    this.stalledNotified = false;

    const platform = this.platform();
    const windowType = streamBrowserWindowType(platform);
    const window = new BrowserWindow({
      width: 480,
      height: 800,
      show: false,
      opacity: 0,
      skipTaskbar: true,
      title: WINDOW_TITLE,
      autoHideMenuBar: true,
      backgroundColor: "#000000",
      // macOS 不要全屏化，也不要在隐藏时留一条窗口阴影。普通窗口类型见 MAC_STREAM_USE_PANEL。
      ...(platform === "darwin" ? { fullscreenable: false, hasShadow: false } : {}),
      ...(windowType ? { type: windowType } : {}),
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: false,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
        partition: "persist:ai-dingbo-stream",
        additionalArguments: ["--dingbo-surface=stream", `--dingbo-stream-session=${_sessionId}`],
      },
    });
    this.window = window;
    this.visible = false;
    markRelaxedContents(window.webContents);
    // 页面加载前就闷住系统输出，避免外放关着时先漏出一声。导航不会清掉这个标志，这里再钉一次。
    this.applySpeakerMute();
    window.webContents.on("did-start-navigation", () => {
      this.applySpeakerMute();
    });

    window.webContents.on("will-navigate", (event, target) => {
      if (isAllowedDouyinUrl(target)) return;
      event.preventDefault();
      logEvent("warn", "stream", "navigation_blocked", { host: safeHost(target) });
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // 红灯 / 关闭按钮只回到隐藏采集。destroy() 不会发 close，会话停止仍走 manager.close()。
    window.on("close", (event) => {
      if (this.releasing || this.window !== window) return;
      event.preventDefault();
      this.applyMode(false);
      logEvent("info", "stream", "user_closed_hidden", {});
      this.options.onUserHid?.();
    });
    window.on("closed", () => {
      if (this.window !== window) return;
      this.window = null;
      this.visible = false;
    });

    // 页面加载前就保持「对 Chromium 可见、对人不可见」。hide() 会让抽头变成全零。
    this.applyMode(false);

    void window.loadURL(url).catch((error: unknown) => {
      logEvent("warn", "stream", "load_failed", {
        message: error instanceof Error ? error.message : "unknown",
      });
    });
  }

  reload(): void {
    if (!this.window || this.window.isDestroyed() || !this.url) return;
    this.audible = this.options.audible?.() ?? this.audible;
    this.applySpeakerMute();
    void this.window.loadURL(this.url).catch((error: unknown) => {
      logEvent("warn", "stream", "reload_failed", {
        message: error instanceof Error ? error.message : "unknown",
      });
    });
  }

  /**
   * 长时间没有音频时的自动处理。
   * Windows：露出登录页。页面本来就在前台抽音，这里只是让人看得见。
   * macOS：不 show()。screen-saver 置顶加 show() 会切 Space、抢走焦点。改为通知主界面。
   */
  reveal(): void {
    if (this.isMac()) {
      this.notifyCaptureStalled();
      return;
    }
    this.applyMode(true);
  }

  setVisible(visible: boolean): boolean {
    if (!this.window || this.window.isDestroyed()) {
      this.visible = false;
      return false;
    }
    this.applyMode(visible);
    return this.visible === visible;
  }

  isVisible(): boolean {
    return Boolean(this.window && !this.window.isDestroyed() && this.visible);
  }

  /**
   * 只改这一窗的系统扬声器。captureStream 抽的是媒体元素，不走这条静音。
   * 隐藏画面时也可以保持不外放。
   */
  setAudible(audible: boolean): void {
    this.audible = audible;
    this.applySpeakerMute();
  }

  private applySpeakerMute(): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    window.webContents.setAudioMuted(streamSpeakerMuted(this.audible));
  }

  private notifyCaptureStalled(): void {
    if (!this.window || this.window.isDestroyed() || this.visible || this.stalledNotified) return;
    this.stalledNotified = true;
    logEvent("info", "stream", "capture_stalled_hidden", {});
    this.options.onCaptureStalled?.({ message: STREAM_CAPTURE_STALL_MESSAGE });
  }

  /**
   * 用户主动显示前调用。Electron 没有「读另一个窗口所在 Space」的 API，
   * 所以先挪到控制窗那块显示器，再短暂加入所有 Space 后退出，窗口留在当前 Space。
   * skipTransformProcessType 避免进程类型来回切：那会短暂藏起 Dock 和窗口，抽音可能断掉。
   */
  private alignToControlWindow(window: BrowserWindow): void {
    const control = this.options.getControlWindow?.() ?? null;
    if (!control || control.isDestroyed()) return;
    try {
      const display = screen.getDisplayMatching(control.getBounds());
      window.setBounds(streamWindowBoundsOnDisplay(display.workArea, window.getBounds()));
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false, skipTransformProcessType: true });
      window.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true });
    } catch (error: unknown) {
      logEvent("warn", "stream", "align_failed", {
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  /**
   * 用户隐藏时不调用 hide()。窗口保持 show，opacity 0、鼠标穿透，
   * 这样 document.visibilityState 仍是 visible，captureStream 才能拿到直播声。
   * Windows 额外用 screen-saver 置顶，避免被挡住后抽成全零。macOS 不用这个级别。
   */
  private applyMode(userVisible: boolean): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    const mode = streamWindowMode(userVisible, this.platform());
    this.visible = userVisible;
    if (userVisible && this.isMac()) this.alignToControlWindow(window);
    window.setFocusable(mode.focusable);
    // macOS 不传 level。隐藏态 alwaysOnTop 为 false。若被挡住后抽成全零，可把隐藏态改回 true：
    // setAlwaysOnTop(true) 的默认级别是 floating，不要改回 screen-saver。
    if (this.isMac()) window.setAlwaysOnTop(mode.alwaysOnTop);
    else window.setAlwaysOnTop(mode.alwaysOnTop, "screen-saver");
    window.setSkipTaskbar(mode.skipTaskbar);
    window.setIgnoreMouseEvents(mode.passThroughMouse, { forward: true });
    if (this.isMac()) window.setHasShadow(userVisible);
    window.setOpacity(mode.opacity);
    if (userVisible) window.show();
    else window.showInactive();
  }

  private platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  private isMac(): boolean {
    return this.platform() === "darwin";
  }

  contents(): WebContents | null {
    return this.window && !this.window.isDestroyed() ? this.window.webContents : null;
  }

  close(): void {
    const window = this.window;
    this.releasing = true;
    this.window = null;
    this.visible = false;
    this.url = "";
    this.stalledNotified = false;
    if (window && !window.isDestroyed()) window.destroy();
    this.releasing = false;
  }
}

function isAllowedDouyinUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    return url.hostname === "douyin.com" || url.hostname.endsWith(".douyin.com");
  } catch {
    return false;
  }
}

function safeHost(raw: string): string | null {
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}
