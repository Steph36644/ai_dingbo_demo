import { useMemo } from "react";
import { useCaptionFollow } from "./useCaptionFollow";
import type { PunctuationOverlay, TranscriptSegment } from "@shared/contracts/transcript";
import type { FrameworkLoadResult } from "@shared/contracts/framework";
import type { SessionSnapshot } from "@shared/contracts/session";
import { presentPunctuatedCaptions } from "@shared/transcript/punctuationDisplay";
import { STATE_LABEL, formatClock } from "./format";

type CaptionMonitorProps = {
  session: SessionSnapshot | null;
  finals: TranscriptSegment[];
  partial: TranscriptSegment | null;
  presentation: PunctuationOverlay | null;
  clockMs: number;
  localError: string | null;
  framework: FrameworkLoadResult | null;
  startBlockReason: string | null;
};

export function CaptionMonitor(props: CaptionMonitorProps) {
  const state = props.session?.state ?? "idle";
  const lines = useMemo(
    () => presentPunctuatedCaptions(props.finals, props.partial, props.presentation ?? null).slice(-200),
    [props.finals, props.partial, props.presentation],
  );
  const latestLine = lines[lines.length - 1] ?? null;
  const captions = useCaptionFollow(
    [lines.length, latestLine?.id ?? "", latestLine?.text ?? "", latestLine?.growing ? "1" : "0"].join("\u0000"),
    lines.length === 0,
  );

  return (
    <section className="caption-monitor" aria-label="盯播监测">
      <header className="caption-head">
        <div>
          <p className="eyebrow">实时字幕</p>
          <h2>{props.session?.phaseDetail ?? "选择来源后开始。问题会在第一个完整窗口结束后出现。"}</h2>
        </div>
        <div className="caption-head-meta">
          <time>{formatClock(props.clockMs)}</time>
          <span>{lines.length} 条</span>
        </div>
      </header>

      {props.startBlockReason ? <p className="banner bad">{props.startBlockReason}</p> : null}
      {props.localError ? <p className="banner bad">{props.localError}</p> : null}
      {props.session?.error ? <p className="banner bad">{props.session.error.message}</p> : null}
      {props.session?.guidance ? <p className="banner">{props.session.guidance}</p> : null}
      {props.session?.state === "degraded" && props.session.reconnectAttempt != null ? (
        <p className="banner">
          自动重连 {props.session.reconnectAttempt}/{props.session.reconnectMaxAttempts}。采音缺口不会被当成超长停顿。
        </p>
      ) : null}
      {props.session?.stopWarning ? <p className="banner">{props.session.stopWarning}</p> : null}
      {props.framework && props.framework.ok === false ? <p className="banner bad">{props.framework.message}</p> : null}

      <div
        className="captions"
        ref={captions.ref}
        onScroll={captions.onScroll}
        onWheel={captions.onWheel}
        onTouchStart={captions.onTouchStart}
        onTouchMove={captions.onTouchMove}
        onPointerDown={captions.onPointerDown}
        role="log"
        aria-live="polite"
        aria-label="实时字幕文稿"
      >
        {lines.length === 0 ? (
          <p className="empty">字幕会显示在这里。模拟音频几秒内就会出第一句；环回要等真实音频帧。</p>
        ) : null}
        <ol className="transcript-document">
          {lines.map((line) => (
            <li
              className={
                line.growing
                  ? "transcript-entry current partial"
                  : line.id === latestLine?.id
                    ? "transcript-entry current"
                    : "transcript-entry history"
              }
              key={line.id}
            >
              <time dateTime={`PT${Math.max(0, line.startMs) / 1000}S`}>{formatClock(line.startMs)}</time>
              <p>
                {line.text}
                {line.growing ? <i aria-hidden="true" /> : null}
              </p>
            </li>
          ))}
        </ol>
      </div>

      <footer className="caption-foot">
        <span>{STATE_LABEL[state] ?? state}</span>
        <span>{props.session?.persistenceNote}</span>
      </footer>
    </section>
  );
}
