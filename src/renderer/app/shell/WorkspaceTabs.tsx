import { WORKSPACES, type Workspace } from "./workspace";

export function WorkspaceTabs({ value, onChange }: { value: Workspace; onChange: (workspace: Workspace) => void }) {
  return (
    <nav className="workspace-tabs" role="tablist" aria-label="工作区">
      {WORKSPACES.map((workspace) => (
        <button
          key={workspace.id}
          type="button"
          role="tab"
          aria-selected={value === workspace.id}
          className={value === workspace.id ? "on" : ""}
          onClick={() => onChange(workspace.id)}
        >
          {workspace.label}
        </button>
      ))}
    </nav>
  );
}
