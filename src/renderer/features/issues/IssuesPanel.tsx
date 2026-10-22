import { useMemo, useState } from "react";
import type { AnalysisDigest, Issue, IssueSeverity, IssueType } from "@shared/contracts/issue";
import { cardSuggestion } from "@shared/issues/suggestions";
import { formatClock } from "../monitor/format";
import "./issueRules.css";

const TYPE_LABEL: Record<IssueType, string> = { content: "内容", pace: "语速", rhythm: "节奏" };
const SEVERITY_LABEL: Record<IssueSeverity, string> = { info: "提示", warning: "警告", critical: "严重" };

const METRIC_LABEL: Record<string, string> = {
  effectiveChars: "有效字数",
  effectiveSpeechMs: "有效语音",
  charsPerMinute: "字/分钟",
  paceMin: "语速下限",
  paceMax: "语速上限",
  deviationRatio: "偏差比例",
  speechMs: "语音时长",
  silenceMs: "静音时长",
  silenceRatio: "静音占比",
  speechRatio: "语音占比",
  longestSilenceMs: "最长停顿",
  sentenceCount: "句段数（诊断）",
  missingCount: "未覆盖条数",
  matchedKeywords: "命中关键词",
  itemLabels: "框架条目",
  frameworkRevision: "框架版本",
};

type IssuesPanelProps = {
  issues: Issue[];
  unreadCount: number;
  qualityWarning: string | null;
  lastAnalysis: AnalysisDigest | null;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  readOnly?: boolean;
  defaultOpenId?: string | null;
  pinnedIssueId?: string | null;
  onPinIssue?: (issueId: string) => void;
  onUnpinIssue?: () => void;
  onDismissIssue?: (issueId: string) => void;
  issueRuleProfileName?: string | null;
  onOpenRules?: () => void;
};

export function IssuesPanel(props: IssuesPanelProps) {
  const [type, setType] = useState<IssueType | "all">("all");
  const [severity, setSeverity] = useState<IssueSeverity | "all">("all");
  const [openId, setOpenId] = useState<string | null>(props.defaultOpenId ?? null);
  const visible = useMemo(
    () => props.issues.filter((issue) => (type === "all" || issue.type === type) && (severity === "all" || issue.severity === severity)),
    [props.issues, severity, type],
  );
  const open = visible.find((issue) => issue.id === openId) ?? null;
  const badgeCount = props.readOnly ? props.issues.length : props.unreadCount;
  const badgeLabel = props.readOnly ? `${badgeCount} 条问题记录` : `${badgeCount} 条未读问题`;

  function toggle(issue: Issue) {
    if (openId === issue.id) {
      setOpenId(null);
      return;
    }
    setOpenId(issue.id);
    if (!props.readOnly && issue.status === "unread") props.onMarkRead(issue.id);
  }

  return (
    <section className="issues" aria-label="问题列表">
      <header className="panel-head">
        <h2>
          问题
          <span className={badgeCount > 0 && !props.readOnly ? "badge hot" : "badge"} aria-label={badgeLabel}>
            {badgeCount}
          </span>
        </h2>
        {props.readOnly ? <span className="analysis-meta">JSONL 只读</span> : (
          <div className="panel-head-actions">
            {props.pinnedIssueId && props.onUnpinIssue ? (
              <button type="button" className="ghost" onClick={props.onUnpinIssue} title="回到自动建议">
                取消钉住
              </button>
            ) : null}
            <button type="button" onClick={props.onMarkAllRead} disabled={props.unreadCount === 0}>
              全部标为已读
            </button>
          </div>
        )}
      </header>
      {props.issueRuleProfileName && !props.readOnly ? (
        <p className="analysis-meta issue-rule-profile">
          警告方案：{props.issueRuleProfileName}
          {props.onOpenRules ? (
            <button type="button" className="ghost" onClick={props.onOpenRules}>
              调整标准
            </button>
          ) : null}
        </p>
      ) : null}
      <div className="filters">
        <label>
          类型
          <select value={type} onChange={(event) => setType(event.target.value as IssueType | "all")}>
            <option value="all">全部</option>
            <option value="content">内容</option>
            <option value="pace">语速</option>
            <option value="rhythm">节奏</option>
          </select>
        </label>
        <label>
          严重度
          <select value={severity} onChange={(event) => setSeverity(event.target.value as IssueSeverity | "all")}>
            <option value="all">全部</option>
            <option value="critical">严重</option>
            <option value="warning">警告</option>
            <option value="info">提示</option>
          </select>
        </label>
      </div>
      {props.qualityWarning ? <p className="banner bad">{props.qualityWarning}</p> : null}
      {props.lastAnalysis ? <p className="analysis-meta">{analysisLine(props.lastAnalysis)}</p> : null}
      {visible.length === 0 ? (
        <p className="empty-dark">
          {props.issues.length === 0
            ? props.readOnly
              ? "本场没有记录到问题。"
              : "还没有问题。分析从第一个完整窗口结束时开始，默认要等满窗口时长。"
            : "当前筛选下没有问题。"}
        </p>
      ) : (
        <ol className="issue-list">
          {visible.map((issue) => (
            <li key={issue.id} className={issue.status === "unread" ? "unread" : "read"}>
              <button type="button" className="issue-card" aria-expanded={openId === issue.id} onClick={() => toggle(issue)}>
                <span className={`sev sev-${issue.severity}`}>{SEVERITY_LABEL[issue.severity]}</span>
                <span className="kind">{TYPE_LABEL[issue.type]}</span>
                <strong>{issue.title}</strong>
                {issue.criterion ? <em className="criterion">判定：{issue.criterion.summary}</em> : null}
                <em className="suggestion">建议：{cardSuggestion(issue)}</em>
                <small>
                  {formatClock(issue.firstSeenAtMs)}–{formatClock(issue.lastSeenAtMs)} · 已出现 {issue.occurrenceCount} 次
                  {props.readOnly ? "" : issue.status === "unread" ? " · 未读" : " · 已读"}
                </small>
                {issue.occurrenceCount > 1 ? <small className="repeat-note">重复 {issue.occurrenceCount - 1} 次</small> : null}
                <small>末次证据 {formatClock(issue.evidence.windowStartMs)}–{formatClock(issue.evidence.windowEndMs)}</small>
              </button>
              {open?.id === issue.id ? (
                <Evidence
                  issue={issue}
                  readOnly={props.readOnly}
                  pinned={props.pinnedIssueId === issue.id}
                  onMarkRead={() => props.onMarkRead(issue.id)}
                  onPinIssue={props.onPinIssue}
                  onDismissIssue={props.onDismissIssue}
                />
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Evidence({
  issue,
  readOnly,
  pinned,
  onMarkRead,
  onPinIssue,
  onDismissIssue,
}: {
  issue: Issue;
  readOnly?: boolean;
  pinned?: boolean;
  onMarkRead: () => void;
  onPinIssue?: (issueId: string) => void;
  onDismissIssue?: (issueId: string) => void;
}) {
  const occurrences = issue.occurrences ?? [];
  return (
    <div className="drawer" role="region" aria-label="问题证据">
      <p>
        <span>出现区间</span>
        {formatClock(issue.firstSeenAtMs)} – {formatClock(issue.lastSeenAtMs)} · 已出现 {issue.occurrenceCount} 次
        {issue.occurrenceCount > 1 ? `（重复 ${issue.occurrenceCount - 1} 次）` : ""}
      </p>
      {issue.criterion ? (
        <p>
          <span>判定标准</span>
          {issue.criterion.summary}
        </p>
      ) : null}
      {issue.criterion?.thresholds?.length ? (
        <p>
          <span>阈值</span>
          {issue.criterion.thresholds.map((threshold) => `${threshold.label} ${threshold.value}`).join("；")}
        </p>
      ) : null}
      <p>
        <span>末次证据窗</span>
        {formatClock(issue.evidence.windowStartMs)} – {formatClock(issue.evidence.windowEndMs)}
      </p>
      {issue.suggestion || cardSuggestion(issue) ? (
        <p>
          <span>建议</span>
          {cardSuggestion(issue)}
        </p>
      ) : null}
      <p>
        <span>框架版本</span>
        <code>{issue.frameworkRevision.slice(0, 12)}</code>
      </p>
      {occurrences.length > 0 ? (
        <div>
          <span>历次证据</span>
          <ol className="occurrence-list">
            {occurrences.map((item, index) => (
              <li className="occurrence" key={`${item.recordedAt}-${item.windowStartMs}-${item.windowEndMs}-${index}`}>
                <time>{formatClock(item.windowStartMs)}–{formatClock(item.windowEndMs)}</time>
                <em>第 {item.occurrenceCount} 次</em>
                {item.excerpts.length === 0 ? <p>这一窗没有可引用的 final 原文。</p> : (
                  <ul>
                    {item.excerpts.map((excerpt) => (
                      <li key={`${excerpt.segmentId}-${excerpt.startMs}`}>
                        <time>{formatClock(excerpt.startMs)}</time>
                        {excerpt.text}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <div>
          <span>原文</span>
          {issue.evidence.excerpts.length === 0 ? <p>这一窗没有可引用的 final 原文。</p> : null}
          <ul>
            {issue.evidence.excerpts.map((excerpt) => (
              <li key={excerpt.segmentId}>
                <time>{formatClock(excerpt.startMs)}</time>
                {excerpt.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <span>指标</span>
        <dl>
          {Object.entries(issue.evidence.metrics).map(([key, value]) => (
            <div key={key}>
              <dt>{METRIC_LABEL[key] ?? key}</dt>
              <dd>{formatMetric(key, value)}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="secret-actions" style={{ marginTop: 10 }}>
        {!readOnly && issue.status === "unread" ? (
          <button type="button" onClick={onMarkRead}>
            标为已读
          </button>
        ) : null}
        {!readOnly && onPinIssue && issue.status === "unread" ? (
          <button type="button" className="ghost" disabled={pinned} onClick={() => onPinIssue(issue.id)}>
            {pinned ? "已钉在大屏" : "钉上大屏"}
          </button>
        ) : null}
        {!readOnly && onDismissIssue ? (
          <button type="button" className="ghost" onClick={() => onDismissIssue(issue.id)}>
            跳过这条
          </button>
        ) : null}
      </div>
    </div>
  );
}

function analysisLine(analysis: AnalysisDigest | null): string {
  if (!analysis) return "还没跑过分析。";
  const flush = analysis.finalFlush ? " · 停止前补跑" : "";
  return `最近分析 ${formatClock(analysis.windowStartMs)}–${formatClock(analysis.windowEndMs)} · ${analysis.durationMs} ms${flush}`;
}

function formatMetric(key: string, value: number | string | boolean): string {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value !== "number") return value;
  if (key.endsWith("Ms")) return `${(value / 1000).toFixed(1)} 秒`;
  if (key.endsWith("Ratio")) return `${Math.round(value * 1000) / 10}%`;
  return String(value);
}
