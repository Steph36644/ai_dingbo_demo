import type { ActionSignal, ActionStatus } from "@shared/contracts/actions";
import { formatClock } from "../monitor/format";
import "./actions.css";

const labels: Record<ActionStatus, string> = {
  pending: "待处理",
  acknowledged: "已确认处理",
  dismissed: "已忽略",
  expired: "已失效",
};

function wallClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

export function ActionCards({
  signals,
  warning,
  onResolve,
  busy = false,
}: {
  signals: ActionSignal[];
  warning: string | null;
  onResolve?: (signal: ActionSignal, status: "acknowledged" | "dismissed") => void;
  busy?: boolean;
}) {
  const ordered = [...signals].sort(
    (a, b) => Number(b.status === "pending") - Number(a.status === "pending") || b.emittedAtMs - a.emittedAtMs,
  );
  return (
    <div className="action-cards" aria-label="动作提醒">
      {warning ? (
        <p className="banner bad" role="status">
          {warning}
        </p>
      ) : null}
      {!signals.length ? <p className="guidance">本场暂无推流 / 发券提醒。</p> : null}
      <ul className="action-list">
        {ordered.map((signal) => (
          <li key={signal.id} className={`action-row action-${signal.status}`}>
            <span className={`action-kind kind-${signal.status}`}>
              {signal.kind === "stream.push_suggested" ? "推流" : "发券"}
            </span>
            <div className="action-main">
              <p>
                {signal.stageLabel} · <time>{wallClock(signal.emittedAtMs)}</time>
              </p>
              <small>
                {signal.status === "pending" && !onResolve ? "未处理（只读）" : labels[signal.status]} · 已覆盖{" "}
                {signal.evidence.items.map((item) => item.text).join("、") || "无"}
              </small>
              <details>
                <summary>查看触发依据</summary>
                <p>
                  分析窗 {formatClock(signal.evidence.windowStartMs)}–{formatClock(signal.evidence.windowEndMs)}
                </p>
                {signal.evidence.excerpts.map((excerpt) => (
                  <blockquote key={excerpt.segmentId}>
                    <time>{formatClock(excerpt.startMs)}</time> {excerpt.text}
                  </blockquote>
                ))}
                {!signal.evidence.excerpts.length ? <p>讲点按本场累计覆盖判断。</p> : null}
                {signal.kind === "coupon.issue_suggested" ? <p>触发窗口无禁讲命中。</p> : null}
                {signal.reason ? <p>{signal.reason}</p> : null}
                {signal.handledAtMs !== null ? <p>处理时间：{wallClock(signal.handledAtMs)}</p> : null}
              </details>
            </div>
            {signal.status === "pending" && onResolve ? (
              <div className="action-buttons">
                <button type="button" disabled={busy} onClick={() => onResolve(signal, "acknowledged")}>
                  确认已处理
                </button>
                <button type="button" className="ghost" disabled={busy} onClick={() => onResolve(signal, "dismissed")}>
                  忽略
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {onResolve ? <p className="guidance">只在中控显示；确认已处理不代表推流或发券成功。</p> : null}
    </div>
  );
}
