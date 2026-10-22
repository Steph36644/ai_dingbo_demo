import path from "node:path";
import { BrowserWindow, desktopCapturer, dialog, session, type WebContents } from "electron";
import type { SessionSnapshot } from "@shared/contracts/session";

export type ControlCloseHook = () => { state: string; stop: () => Promise<SessionSnapshot>; closeStage: () => void };

export function createMainWindow(hooks?: { onControlClose?: ControlCloseHook }): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 920,
    minWidth: 880,
    minHeight: 720,
    title: "AI盯播",
    backgroundColor: "#12160f",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
    },
  });

  if (hooks?.onControlClose) {
    window.on("close", (event) => {
      const hook = hooks.onControlClose?.();
      if (!hook) return;
      if (hook.state === "idle" || hook.state === "completed" || hook.state === "error") {
        hook.closeStage();
        return;
      }
      event.preventDefault();
      const choice = dialog.showMessageBoxSync(window, {
        type: "warning",
        title: "停止盯播",
        message: "停止盯播并关掉抬头屏？",
        buttons: ["停止并关闭", "取消"],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice === 1) return;
      hook.closeStage();
      void hook.stop().finally(() => {
        window.destroy();
      });
    });
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, "../renderer/index.html"));
    installProductionCsp(window);
  }

  return window;
}

export function installDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      const source = sources[0];
      if (!source) {
        callback({});
        return;
      }
      callback({ video: source, audio: "loopback" });
    } catch {
      callback({});
    }
  });

  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === "media" || permission === "display-capture");
  });
}

/**
 * 例外窗口（直播流播放窗）自己装域名白名单。这里只登记，判断放在事件触发时：
 * web-contents-created 在 BrowserWindow 构造期间就触发，早于调用方拿到引用。
 */
const relaxedContents = new WeakSet<WebContents>();

export function markRelaxedContents(contents: WebContents): void {
  relaxedContents.add(contents);
}

export function hardenContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  contents.on("will-navigate", (event, url) => {
    if (relaxedContents.has(contents)) return;
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl && url.startsWith(devUrl)) return;
    if (url.startsWith("file://")) return;
    event.preventDefault();
  });
}

function installProductionCsp(window: BrowserWindow): void {
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
