import { useEffect, useRef, useState } from "react";
import type { SessionCatalogEntry } from "@shared/contracts/replay";
import { formatClock } from "../monitor/format";

export function SessionCatalog(props: {
  sessions: SessionCatalogEntry[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  function beginEdit(session: SessionCatalogEntry) {
    setEditingId(session.sessionId);
    setDraft(session.displayTitle);
    setRenameError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft("");
    setRenameError(null);
  }

  async function commitEdit() {
    if (!editingId) return;
    const trimmed = draft.trim();
    setSaving(true);
    setRenameError(null);
    try {
      const result = await props.onRename(editingId, trimmed);
      if (!result.ok) {
        setRenameError(result.message ?? "保存失败。");
        return;
      }
      cancelEdit();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="session-catalog" aria-label="历史场次">
      <header>
        <h2>场次目录</h2>
        <p>这里是本机已经写入的场次。点开后仍是字幕和问题的只读回看。双击标题可以改名。</p>
      </header>
      {props.loading ? <p className="empty">正在读取本机场次…</p> : null}
      {props.error ? <p className="banner bad">{props.error}</p> : null}
      {!props.loading && !props.error && props.sessions.length === 0 ? (
        <p className="empty">还没有已落盘的历史场次。停播并成功写入后，可以在这里打开。</p>
      ) : null}
      {props.truncated ? <p className="empty">只列出最近 200 场。</p> : null}
      <ol>
        {props.sessions.map((session) => {
          const active = session.sessionId === props.activeSessionId;
          const editing = editingId === session.sessionId;
          return (
            <li key={session.sessionId}>
              <div className={active ? "session-row on" : "session-row"}>
                {editing ? (
                  <div className="session-rename">
                    <input
                      ref={inputRef}
                      type="text"
                      value={draft}
                      maxLength={60}
                      disabled={saving}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void commitEdit();
                        if (event.key === "Escape") cancelEdit();
                      }}
                      aria-label="场次名称"
                    />
                    <button type="button" className="ghost" disabled={saving} onClick={() => void commitEdit()}>
                      保存
                    </button>
                    <button type="button" className="ghost" disabled={saving} onClick={cancelEdit}>
                      取消
                    </button>
                    {renameError ? <p className="guidance bad-text">{renameError}</p> : null}
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="session-open"
                      aria-current={active ? "true" : undefined}
                      onClick={() => props.onSelect(session.sessionId)}
                    >
                      <strong
                        onDoubleClick={(event) => {
                          event.preventDefault();
                          beginEdit(session);
                        }}
                        title="双击改名"
                      >
                        {session.displayTitle}
                      </strong>
                      <span>{formatWhen(session.startedAt)} · {formatClock(session.durationMs)}</span>
                      <small>
                        {session.finalCount} 条字幕 · {session.issueCount} 条问题
                        {session.frameworkTitle ? ` · ${session.frameworkTitle}` : ""}
                      </small>
                    </button>
                    <button
                      type="button"
                      className="ghost session-rename-trigger"
                      onClick={() => beginEdit(session)}
                      aria-label={`改名 ${session.displayTitle}`}
                    >
                      改名
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function formatWhen(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleString();
}
