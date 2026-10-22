import path from "node:path";
import { app, BrowserWindow, screen, type Display } from "electron";
import type { StageOpenRequest } from "../../shared/contracts/display";
import type { StageTranscriptPayload, StageView } from "../../shared/contracts/stage";
import type { TranscriptView } from "../../shared/contracts/transcript";
import { findDisplay } from "./displays";

export type StageWindowHooks = {
  getControlWindow: () => BrowserWindow | null;
  getStageView: () => StageView;
  getTranscript: () => TranscriptView;
  onStageClosed: () => void;
  onDisplayDisconnected: (displayId: number) => void;
  onLoadFailed: (message: string) => void;
};

export class StageWindowManager {
  private stageWindow: BrowserWindow | null = null;
  private currentDisplayId: number | null = null;
  private mode: "window" | "fullscreen" | null = null;
  private displayListenersAttached = false;

  /**
   * 可以在 `app.whenReady()` 之前构造。
   * Electron 的 `screen` 在 ready 之前访问会抛
   * "The 'screen' module can't be used before the app 'ready' event"。
   * 这里只登记 ready 回调，真正的 `screen.on` 放在 `attachDisplayListeners`。
   */
  constructor(private readonly hooks: StageWindowHooks) {
    void app.whenReady().then(() => {
      this.attachDisplayListeners();
    });
  }

  /** 必须在 app ready 之后调用。重复调用不会重复订阅。 */
  attachDisplayListeners(): void {
    if (this.displayListenersAttached) return;
    this.displayListenersAttached = true;
    screen.on("display-removed", (_event, display) => {
      if (this.currentDisplayId === display.id) {
        this.destroy();
        this.hooks.onDisplayDisconnected(display.id);
      }
    });
    screen.on("display-metrics-changed", (_event, display) => {
      if (this.currentDisplayId === display.id && this.stageWindow && !this.stageWindow.isDestroyed()) {
        this.placeOnDisplay(display, this.mode ?? "window");
      }
    });
  }

  isOpen(): boolean {
    return this.stageWindow != null && !this.stageWindow.isDestroyed();
  }

  contents() {
    return this.isOpen() ? this.stageWindow!.webContents : null;
  }

  open(request: StageOpenRequest): { ok: boolean; message?: string } {
    const display = findDisplay(request.displayId);
    if (!display) return { ok: false, message: "所选显示器不存在，请重新选择。" };

    const control = this.hooks.getControlWindow();
    if (request.mode === "fullscreen" && control && !control.isDestroyed()) {
      const controlBounds = control.getBounds();
      const controlDisplay = screen.getDisplayNearestPoint({ x: controlBounds.x, y: controlBounds.y });
      if (controlDisplay.id === display.id) {
        return { ok: false, message: "全屏抬头屏必须放在另一块显示器上。单屏请选「窗口」或「本屏排练」。" };
      }
    }

    if (this.isOpen()) this.destroy();

    const fullscreen = request.mode === "fullscreen";
    const window = new BrowserWindow({
      title: "AI盯播 · 抬头屏",
      backgroundColor: "#0a0d10",
      frame: !fullscreen,
      fullscreen: false,
      fullscreenable: false,
      resizable: !fullscreen,
      movable: !fullscreen,
      minimizable: !fullscreen,
      maximizable: !fullscreen,
      hasShadow: !fullscreen,
      autoHideMenuBar: true,
      webPreferences: {
        additionalArguments: ["--dingbo-surface=stage"],
        preload: path.join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
        devTools: !app.isPackaged,
      },
    });

    this.stageWindow = window;
    this.currentDisplayId = display.id;
    this.mode = request.mode;

    this.placeOnDisplay(display, request.mode);

    const url = this.stageUrl(request.mode);
    if (process.env.ELECTRON_RENDERER_URL) {
      void window.loadURL(url);
    } else {
      void window.loadFile(path.join(__dirname, "../renderer/index.html"), {
        query: { surface: "stage", mode: request.mode },
      });
      this.installProductionCsp(window);
    }

    window.on("closed", () => {
      this.stageWindow = null;
      this.currentDisplayId = null;
      this.mode = null;
      this.hooks.onStageClosed();
    });

    window.webContents.on("will-navigate", (event, target) => {
      if (target === url || target.startsWith(`${url}#`)) return;
      event.preventDefault();
      void window.loadURL(url);
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());

    window.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      if (input.key === "Escape") {
        event.preventDefault();
        this.destroy();
        this.hooks.onStageClosed();
      }
      if ((input.control || input.meta) && input.key.toLowerCase() === "r") {
        event.preventDefault();
      }
    });

    window.webContents.on("did-finish-load", () => {
      window.webContents.send("stage:push", this.hooks.getStageView());
      window.webContents.send("stage:transcript", this.toStagePayload(this.hooks.getTranscript()));
    });

    window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
      if (errorCode === -3) return; // ERR_ABORTED：重载/导航切换，不是失败。
      if (window.isDestroyed()) return;
      this.destroy();
      this.hooks.onLoadFailed(errorDescription || "抬头屏页面加载失败。");
      this.hooks.onStageClosed();
    });

    return { ok: true };
  }

  close(): void {
    this.destroy();
  }

  push(view: StageView): void {
    if (this.stageWindow && !this.stageWindow.isDestroyed()) {
      this.stageWindow.webContents.send("stage:push", view);
    }
  }

  /** 把最新字幕快照推给 Stage 窗口。 */
  pushTranscript(view: TranscriptView): void {
    if (this.stageWindow && !this.stageWindow.isDestroyed()) {
      this.stageWindow.webContents.send("stage:transcript", this.toStagePayload(view));
    }
  }

  /** 把 TranscriptView 转成 Stage 需要的精简载荷。 */
  private toStagePayload(view: TranscriptView): StageTranscriptPayload {
    return {
      sessionId: view.sessionId,
      finals: view.finals,
      partial: view.partial,
      presentation: view.presentation ?? null,
    };
  }

  private destroy(): void {
    if (this.stageWindow && !this.stageWindow.isDestroyed()) {
      this.stageWindow.destroy();
    }
    this.stageWindow = null;
    this.currentDisplayId = null;
    this.mode = null;
  }

  private placeOnDisplay(display: Display, mode: "window" | "fullscreen"): void {
    if (!this.stageWindow || this.stageWindow.isDestroyed()) return;
    const bounds = display.bounds;
    if (mode === "fullscreen") {
      this.stageWindow.setBounds(bounds);
      return;
    }
    const work = display.workArea;
    const width = Math.min(960, Math.floor(work.width * 0.7));
    const height = Math.min(540, Math.floor(work.height * 0.7));
    const x = work.x + work.width - width - 24;
    const y = work.y + 24;
    this.stageWindow.setBounds({ x, y, width, height });
  }

  private stageUrl(mode: "window" | "fullscreen"): string {
    const query = `surface=stage&mode=${mode}`;
    if (process.env.ELECTRON_RENDERER_URL) {
      return `${process.env.ELECTRON_RENDERER_URL}?${query}`;
    }
    return `file://${path.join(__dirname, "../renderer/index.html")}?${query}`;
  }

  private installProductionCsp(window: BrowserWindow): void {
    window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:",
          ],
        },
      });
    });
  }
}
