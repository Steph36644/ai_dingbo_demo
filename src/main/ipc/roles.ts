import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";

/** Identity comes from Main-owned windows, never renderer URL parameters. */
export function isWindowSender(
  event: Pick<IpcMainInvokeEvent | IpcMainEvent, "sender" | "senderFrame">,
  contents: WebContents | null | undefined,
): boolean {
  return !!contents && !contents.isDestroyed() &&
    event.sender === contents && event.senderFrame === contents.mainFrame;
}

export function controlContents(window: BrowserWindow | null): WebContents | null {
  return window && !window.isDestroyed() ? window.webContents : null;
}
