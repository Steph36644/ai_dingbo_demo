import type { ReactNode } from "react";

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <p className="empty-state-title">{title}</p>
      {hint ? <p className="empty-state-hint">{hint}</p> : null}
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}
