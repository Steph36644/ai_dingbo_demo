import { useEffect, useMemo, useRef, useState } from "react";
import type { StageTranscriptPayload, StageView } from "@shared/contracts/stage";
import { presentPunctuatedCaptions } from "@shared/transcript/punctuationDisplay";
import "./stage.css";

const HEALTH_LABEL: Record<StageView["health"], string> = {
  idle: "已停",
  ok: "进行中",
  degraded: "不稳定",
  error: "已停",
};

function readMode(): "window" | "fullscreen" {
  const mode = new URLSearchParams(window.location.search).get("mode");
  return mode === "fullscreen" ? "fullscreen" : "window";
}

export function StageView() {
  const [view, setView] = useState<StageView | null>(null);
  const [transcript, setTranscript] = useState<StageTranscriptPayload | null>(null);
  const captionsRef = useRef<HTMLDivElement>(null);
  const mode = useMemo(readMode, []);

  useEffect(() => {
    const bridge = window.dingbo;
    if (!bridge) return;
    void bridge.getStageState().then(setView);
    void bridge.getStageTranscript().then(setTranscript);
    const offPush = bridge.onStagePush(setView);
    const offTranscript = bridge.onStageTranscript(setTranscript);
    return () => {
      offPush();
      offTranscript();
    };
  }, []);

  const health = view?.health ?? "idle";
  const sessionId = view?.sessionId ?? null;
  const unreadCount = view?.unreadCount ?? 0;
  const suggestion = view?.suggestion ?? null;

  let displayStage = view?.stageLabel || "等待盯播开始";
  let displaySuggestion: string | null = suggestion;
  let showBadge = true;

  if (!sessionId) {
    displayStage = "等待盯播开始";
    displaySuggestion = null;
    showBadge = false;
  } else if (health === "error") {
    displayStage = "信号中断";
    displaySuggestion = "先听你说";
  } else if (health === "degraded" && !suggestion) {
    displaySuggestion = "转写不稳定，看中控";
  }

  const captionLines = useMemo(() => {
    if (!transcript) return [];
    return presentPunctuatedCaptions(
      transcript.finals,
      transcript.partial,
      transcript.presentation ?? null,
    ).slice(-50);
  }, [transcript]);

  useEffect(() => {
    const el = captionsRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [captionLines.length]);

  return (
    <div className="stage-surface">
      <header className="stage-topline">
        <div className="stage-status">
          <span
            className={`stage-health stage-health-${health}`}
            aria-label={HEALTH_LABEL[health]}
            title={HEALTH_LABEL[health]}
          />
          {mode === "window" ? <span className="stage-rehearsal">排练</span> : null}
        </div>
        {showBadge ? (
          <div className="stage-badge" aria-label={`${unreadCount} 条未读问题`}>
            {unreadCount}
          </div>
        ) : null}
      </header>

      <section className="stage-hero">
        <h1 className="stage-stage-label">{displayStage}</h1>
        {displaySuggestion ? (
          <p className="stage-suggestion" role="status">
            {displaySuggestion}
          </p>
        ) : null}
      </section>

      <section className="stage-caption-window">
        <div className="stage-captions" ref={captionsRef} role="log" aria-live="polite" aria-label="直播字幕">
          {captionLines.length === 0 ? (
            <p className="stage-captions-empty">字幕会显示在这里</p>
          ) : (
            <ol className="stage-caption-list">
              {captionLines.map((line, index) => (
                <li
                  key={line.id}
                  className={
                    index === captionLines.length - 1
                      ? "stage-caption-line stage-caption-current"
                      : "stage-caption-line"
                  }
                >
                  {line.text}
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}
