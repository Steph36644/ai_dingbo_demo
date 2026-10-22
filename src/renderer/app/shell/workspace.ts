export type Workspace = "monitor" | "replay" | "settings";

export const WORKSPACES: ReadonlyArray<{ id: Workspace; label: string }> = [
  { id: "monitor", label: "盯播" },
  { id: "replay", label: "回看" },
  { id: "settings", label: "设置" },
];

export function dockStorageKey(workspace: Workspace, dockId: string): string {
  return `dingbo.dock.${workspace}.${dockId}`;
}

export function readDockCollapsed(storage: Pick<Storage, "getItem"> | null, workspace: Workspace, dockId: string): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(dockStorageKey(workspace, dockId)) === "1";
  } catch {
    return false;
  }
}

export function writeDockCollapsed(
  storage: Pick<Storage, "setItem"> | null,
  workspace: Workspace,
  dockId: string,
  collapsed: boolean,
): void {
  if (!storage) return;
  try {
    storage.setItem(dockStorageKey(workspace, dockId), collapsed ? "1" : "0");
  } catch {
    // 本机存储不可写时保持当前会话状态即可。
  }
}
