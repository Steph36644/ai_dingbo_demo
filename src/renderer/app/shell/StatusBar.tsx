type StatusBarProps = {
  stateLabel: string;
  stateTone: "idle" | "running" | "error" | "done";
  clock: string;
  sourceLabel: string;
  asrLabel: string;
  persistenceLabel: string;
  unreadCount: number;
  note?: string | null;
};

export function StatusBar({
  stateLabel,
  stateTone,
  clock,
  sourceLabel,
  asrLabel,
  persistenceLabel,
  unreadCount,
  note,
}: StatusBarProps) {
  return (
    <footer className="statusbar" role="status">
      <span className={`statusbar-state tone-${stateTone}`}>{stateLabel}</span>
      <span className="statusbar-clock">{clock}</span>
      <span className="statusbar-sep" aria-hidden="true" />
      <span>{sourceLabel}</span>
      <span className="statusbar-sep" aria-hidden="true" />
      <span>{asrLabel}</span>
      <span className="statusbar-sep" aria-hidden="true" />
      <span>{persistenceLabel}</span>
      <span className="statusbar-sep" aria-hidden="true" />
      <span className={unreadCount > 0 ? "statusbar-unread hot" : "statusbar-unread"}>{unreadCount} 未读</span>
      {note ? <span className="statusbar-note">{note}</span> : null}
      <span className="statusbar-declare">内容盯播，不是 GMV 总控。</span>
    </footer>
  );
}
