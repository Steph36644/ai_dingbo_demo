import type { SessionCatalogEntry, SessionReplayView } from "@shared/contracts/replay";
import type { PunctuationOverlay } from "@shared/contracts/transcript";
import { EmptyState } from "../../app/shell/EmptyState";
import { SessionCatalog } from "./SessionCatalog";
import { ReplayView } from "./ReplayView";

type ReplayWorkspaceProps = {
  locked: boolean;
  catalog: SessionCatalogEntry[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  activeSessionId: string | null;
  replay: SessionReplayView | null;
  replayLoading: boolean;
  replayError: string | null;
  hasCurrent: boolean;
  showCurrent: boolean;
  presentation: PunctuationOverlay | null;
  onSelect: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => Promise<{ ok: boolean; message?: string }>;
  onBackToCurrent: () => void;
  onRematch: () => void;
  onRefresh: () => void;
};

export function ReplayWorkspace(props: ReplayWorkspaceProps) {
  return (
    <div className="replay-workspace">
      <aside className="replay-catalog" aria-label="场次目录">
        <header className="dock-head">
          <h2>场次目录</h2>
          <div className="dock-head-actions">
            <button type="button" className="ghost" onClick={props.onRefresh}>
              刷新
            </button>
            {props.showCurrent && props.hasCurrent ? (
              <button type="button" className="ghost" onClick={props.onBackToCurrent}>
                返回本场
              </button>
            ) : null}
          </div>
        </header>
        {props.locked ? <p className="guidance">盯播进行中，目录不含本场。</p> : null}
        <SessionCatalog
          sessions={props.catalog}
          loading={props.loading}
          error={props.error}
          truncated={props.truncated}
          activeSessionId={props.activeSessionId}
          onSelect={props.onSelect}
          onRename={props.onRename}
        />
      </aside>
      <div className="replay-main">
        {props.replayLoading ? <p className="banner">正在从 JSONL 载入只读回看…</p> : null}
        {props.replayError ? <p className="banner bad">{props.replayError}</p> : null}
        {props.replay ? (
          <ReplayView replay={props.replay} presentation={props.presentation} />
        ) : (
          <EmptyState
            title="选择一场回看"
            hint="左侧目录按时间列出本机 JSONL。回看只读，不改本场记录。"
            action={
              <button type="button" className="ghost" onClick={props.onRematch}>
                再盯一场
              </button>
            }
          />
        )}
      </div>
    </div>
  );
}
