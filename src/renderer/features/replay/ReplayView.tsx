import { useMemo } from "react";
import type { SessionReplayView } from "@shared/contracts/replay";
import type { PunctuationOverlay } from "@shared/contracts/transcript";
import { presentPunctuatedCaptions } from "@shared/transcript/punctuationDisplay";
import { IssuesPanel } from "../issues/IssuesPanel";
import { formatClock } from "../monitor/format";
import { ActionCards } from "../actions/ActionCards";

export function ReplayView({ replay, presentation = null }: { replay: SessionReplayView; presentation?: PunctuationOverlay | null }) {
  const lines = useMemo(
    () => presentPunctuatedCaptions(replay.finals, null, presentation).slice(-200),
    [replay.finals, presentation],
  );
  const signals = replay.actionHistory?.signals ?? [];
  const pendingCount = signals.filter((signal) => signal.status === "pending").length;
  return (
    <div className="replay-view">
      <section className="stage replay-stage" aria-label="本场 JSONL 字幕回看">
        <header className="stage-head">
          <div>
            <p className="eyebrow">JSONL 只读回看</p>
            <h2>{replay.summary.frameworkTitle ?? "本场盯播复盘"}</h2>
          </div>
          <time>{formatClock(replay.summary.durationMs)}</time>
        </header>
        <p className="replay-summary">
          {new Date(replay.summary.startedAt).toLocaleString()} · {replay.summary.finalCount} 条 final 字幕 · {replay.summary.issueCount} 条问题
        </p>
        <div className="captions" role="log" aria-label="本场 final 字幕摘要">
          {lines.length === 0 ? <p className="empty">本场没有 final 字幕。</p> : null}
          <ol className="transcript-document">
            {lines.map((line) => (
              <li className="transcript-entry history" key={line.id}>
                <time>{formatClock(line.startMs)}</time>
                <p>{line.text}</p>
              </li>
            ))}
          </ol>
        </div>
        <footer><span>数据已从这场 session.jsonl 重新读取</span><span>{replay.summary.sessionId}</span></footer>
      </section>
      <div className="analysis replay-analysis">
        <section className="replay-panel replay-actions" aria-label="本场动作提醒">
          <header className="panel-head">
            <h2>
              动作提醒
              <span className={pendingCount > 0 ? "badge hot" : "badge"} aria-label={`${pendingCount} 条未处理提醒`}>
                {pendingCount}
              </span>
            </h2>
            <span className="analysis-meta">本场记录</span>
          </header>
          <ActionCards signals={signals} warning={replay.actionHistory?.warning ?? null} />
        </section>
        <IssuesPanel
          issues={replay.issues}
          unreadCount={0}
          qualityWarning={null}
          lastAnalysis={null}
          readOnly
          onMarkRead={() => undefined}
          onMarkAllRead={() => undefined}
        />
      </div>
    </div>
  );
}
