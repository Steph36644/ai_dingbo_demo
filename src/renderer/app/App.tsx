import { useEffect, useRef, useState } from "react";
import type { AsrHealth, AsrId } from "@shared/contracts/asr";
import type { AudioSourceId, DeviceListResult } from "@shared/contracts/audio";
import type { DisplayInfo, StagePreferences } from "@shared/contracts/display";
import type { FrameworkLoadResult } from "@shared/contracts/framework";
import type { AnalysisDigest, CoverageItem, Issue } from "@shared/contracts/issue";
import type { SettingsSnapshot, SettingsUpdateResult } from "@shared/contracts/ipc";
import type { SecretStatus } from "@shared/contracts/secrets";
import type { SessionCatalogEntry, SessionReplayView } from "@shared/contracts/replay";
import type { DemoScriptId, SessionSnapshot } from "@shared/contracts/session";
import type { PunctuationOverlay, TranscriptSegment } from "@shared/contracts/transcript";
import { startControlState, xfyunStartBlockReason } from "@shared/session/credentialGate";
import { normalizeDouyinLiveUrl } from "@shared/live/douyin";
import { summarizeDiagnostic } from "@shared/text/diagnostics";
import { pipeLoopback, primeLoopbackCapture, stopStream } from "../features/monitor/capture";
import { STATE_LABEL, formatClock } from "../features/monitor/format";
import { ControlWorkspace } from "../features/monitor/ControlWorkspace";
import { presentationForReplay } from "../features/replay/replayPresentation";
import { ReplayWorkspace } from "../features/replay/ReplayWorkspace";
import { SettingsWorkspace } from "../features/settings/SettingsWorkspace";
import { StageView } from "../features/stage/StageView";
import { StatusBar } from "./shell/StatusBar";
import { ToastHost } from "./shell/ToastHost";
import type { ToastItem, ToastKind } from "./shell/toast";
import { WorkspaceTabs } from "./shell/WorkspaceTabs";
import type { Workspace } from "./shell/workspace";

const APP_VERSION = "1.0.0";

function surface(): "control" | "stage" {
  if (typeof window === "undefined") return "control";
  const value = new URLSearchParams(window.location.search).get("surface");
  return value === "stage" ? "stage" : "control";
}

export function App() {
  if (surface() === "stage") return <StageView />;
  return <ControlApp />;
}

function ControlApp() {
  const bridge = typeof window === "undefined" ? undefined : window.dingbo;
  const [workspace, setWorkspace] = useState<Workspace>("monitor");
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [devices, setDevices] = useState<DeviceListResult | null>(null);
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [xfyunSecret, setXfyunSecret] = useState<SecretStatus | null>(null);
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [finals, setFinals] = useState<TranscriptSegment[]>([]);
  const [partial, setPartial] = useState<TranscriptSegment | null>(null);
  const [presentation, setPresentation] = useState<PunctuationOverlay | null>(null);
  const [rms, setRms] = useState(0);
  const [clockMs, setClockMs] = useState(0);
  const [source, setSource] = useState<AudioSourceId>("simulated");
  const [streamUrl, setStreamUrl] = useState("");
  const [streamWindowVisible, setStreamWindowVisible] = useState(false);
  const [asrId, setAsrId] = useState<AsrId>("fake");
  const [demoScript, setDemoScript] = useState<DemoScriptId>("standard");
  const [framework, setFramework] = useState<FrameworkLoadResult | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [coverage, setCoverage] = useState<CoverageItem[]>([]);
  const [qualityWarning, setQualityWarning] = useState<string | null>(null);
  const [lastAnalysis, setLastAnalysis] = useState<AnalysisDigest | null>(null);
  const [pinnedIssueId, setPinnedIssueId] = useState<string | null>(null);
  const [issueRuleProfileName, setIssueRuleProfileName] = useState<string | null>(null);
  const [productNote, setProductNote] = useState("");
  const [currentStageId, setCurrentStageId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [asrHealth, setAsrHealth] = useState<AsrHealth | null>(null);
  const [healthChecking, setHealthChecking] = useState(false);
  const [replay, setReplay] = useState<SessionReplayView | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<SessionCatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogTruncated, setCatalogTruncated] = useState(false);
  const [pinnedSessionId, setPinnedSessionId] = useState<string | null>(null);
  const [stageDisplays, setStageDisplays] = useState<DisplayInfo[]>([]);
  const [selectedDisplayId, setSelectedDisplayId] = useState<number | null>(null);
  const [stageMode, setStageMode] = useState<"window" | "fullscreen">("window");
  const [stageMessage, setStageMessage] = useState<string | null>(null);
  const healthRequest = useRef(0);
  const replayRequest = useRef(0);
  const catalogRequest = useRef(0);
  const toastSeq = useRef(0);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const armed = useRef<MediaStream | null>(null);
  const captureStream = useRef<MediaStream | null>(null);
  const stopPipe = useRef<(() => void) | null>(null);

  function toast(kind: ToastKind, message: string, action?: { actionLabel: string; onAction: () => void }) {
    const id = ++toastSeq.current;
    setToasts((current) => [...current, { id, kind, message, ...action }].slice(-3));
    if (kind !== "error" && !action) {
      setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 5000);
    }
  }

  useEffect(() => {
    if (!bridge) return;
    let stop = false;
    void Promise.all([
      bridge.listDevices(),
      bridge.getSettings(),
      bridge.getXfyunSecretStatus(),
      bridge.getSession(),
      bridge.getTranscript(),
      bridge.loadFramework(),
      bridge.getAnalysis(),
      bridge.listStageDisplays(),
      bridge.getStagePreferences(),
      bridge.getStreamWindowVisible(),
    ]).then(([deviceList, settingsSnapshot, xfyunSecretStatus, sessionSnapshot, transcript, frameworkResult, analysis, displays, preferences, streamWindow]) => {
      if (stop) return;
      setDevices(deviceList);
      setStreamWindowVisible(streamWindow.visible);
      if (deviceList.loopbackAttemptAllowed && deviceList.support === "available") setSource("loopback");
      setSettings(settingsSnapshot);
      setXfyunSecret(xfyunSecretStatus);
      setSession(sessionSnapshot);
      setFinals(transcript.finals);
      setPartial(transcript.partial);
      setPresentation(transcript.presentation ?? null);
      setClockMs(sessionSnapshot.audioClockMs);
      setFramework(frameworkResult);
      setIssues(analysis.issues);
      setUnreadCount(analysis.unreadCount);
      setCoverage(analysis.coverage);
      setQualityWarning(analysis.qualityWarning);
      setLastAnalysis(analysis.lastAnalysis);
      setPinnedIssueId(analysis.pinnedIssueId);
      setIssueRuleProfileName(analysis.issueRuleProfileName);
      setStageDisplays(displays);
      setStageMode(preferences.mode);
      if (displays.length === 0) {
        setSelectedDisplayId(null);
      } else if (preferences.displayId != null && displays.some((display) => display.id === preferences.displayId)) {
        setSelectedDisplayId(preferences.displayId);
      } else {
        const fallback = displays.find((display) => display.internal) ?? displays[0];
        setSelectedDisplayId(fallback.id);
        if (preferences.displayId != null) toast("warn", "上次使用的抬头屏未连接，已改选主屏。");
      }
    });
    const offState = bridge.onSessionState((snapshot) => {
      setSession(snapshot);
      setClockMs((current) => Math.max(current, snapshot.audioClockMs));
    });
    const offPresentation = bridge.onPresentation((event) => {
      setPresentation(event.overlay);
    });
    const offTranscript = bridge.onTranscript((delta) => {
      if (delta.kind === "reset") {
        setFinals([]);
        setPartial(null);
        setPresentation(null);
        setRms(0);
        setClockMs(0);
        setIssues([]);
        setUnreadCount(0);
        setCoverage([]);
        setQualityWarning(null);
        setLastAnalysis(null);
        setPinnedIssueId(null);
        return;
      }
      if (delta.kind === "partial") {
        setPartial(delta.segment);
        return;
      }
      setFinals((current) => {
        if (current.some((item) => item.id === delta.segment.id)) return current;
        return [...current, delta.segment].sort((a, b) => a.startMs - b.startMs);
      });
      setPartial((current) => (current?.sourceResultId === delta.segment.sourceResultId ? null : current));
    });
    const offLevel = bridge.onLevel((level) => {
      setRms(level.rms);
      setClockMs(level.audioClockMs);
    });
    const offIssues = bridge.onIssues((event) => {
      setIssues(event.issues);
      setUnreadCount(event.unreadCount);
      setQualityWarning(event.qualityWarning);
      setLastAnalysis(event.lastAnalysis);
      setIssueRuleProfileName(event.issueRuleProfileName);
      for (const recurrence of event.recurrences.slice(0, 3)) {
        const repeats = recurrence.occurrenceCount - 1;
        toast("warn", repeats > 0 ? `「${recurrence.title}」又出现了 · 已重复 ${repeats} 次` : `「${recurrence.title}」再次出现`);
      }
    });
    const offCoverage = bridge.onCoverage((event) => setCoverage(event.items));
    const offCapture = bridge.onBeginCapture((event) => {
      const stream = captureStream.current;
      const live = stream?.getAudioTracks().some((track) => track.readyState === "live") ?? false;
      if (!stream || !live) {
        bridge.notifyCaptureFailed(event.sessionId, "渲染进程没有可用的环回音轨。");
        return;
      }
      stopPipe.current?.();
      stopPipe.current = pipeLoopback(stream, event.sessionId, bridge.pushAudioChunk, (message) => {
        bridge.notifyCaptureFailed(event.sessionId, message);
        setLocalError(message);
      });
    });
    const offLoadFailed = bridge.onStageLoadFailed((payload) => {
      setStageMessage(payload.message);
      toast("error", "抬头屏打开失败，盯播还在。");
    });
    const offDisconnected = bridge.onStageDisplayDisconnected(() => {
      toast("warn", "抬头屏断开，盯播还在。");
    });
    const offStreamVisibility = bridge.onStreamWindowVisibility((state) => {
      setStreamWindowVisible(state.visible);
    });
    const offStalled = bridge.onStreamCaptureStalled((notice) => {
      toast("warn", notice.message, {
        actionLabel: "显示画面",
        onAction: () => {
          void bridge.setStreamWindowVisible(true).then(
            (result) => setStreamWindowVisible(result.visible),
            (error: unknown) => setLocalError(error instanceof Error ? error.message : "切换直播画面失败。"),
          );
        },
      });
    });
    return () => {
      stop = true;
      healthRequest.current += 1;
      replayRequest.current += 1;
      offState();
      offTranscript();
      offPresentation();
      offLevel();
      offIssues();
      offCoverage();
      offCapture();
      offLoadFailed();
      offDisconnected();
      offStreamVisibility();
      offStalled();
      stopPipe.current?.();
      stopStream(captureStream.current);
      if (noteTimer.current) clearTimeout(noteTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  useEffect(() => {
    const state = session?.state ?? "idle";
    const sessionLocked = state === "preparing" || state === "running" || state === "degraded" || state === "stopping";
    if (!bridge || sessionLocked) return;
    void checkHealth();
    // 凭据内容改变后，旧讯飞健康结果不能继续放行。
  }, [bridge, asrId, xfyunSecret, session?.state]);

  useEffect(() => {
    if (!bridge) return;
    if (pinnedSessionId) return;
    if (session?.state !== "completed" || session.persistence !== "jsonl") {
      replayRequest.current += 1;
      setReplay(null);
      setReplayError(null);
      setReplayLoading(false);
      return;
    }
    const request = ++replayRequest.current;
    setReplay(null);
    setReplayLoading(true);
    setReplayError(null);
    void bridge.loadCurrentReplay().then((result) => {
      if (request !== replayRequest.current) return;
      if (result.ok) setReplay(result.replay);
      else {
        setReplay(null);
        setReplayError(result.message);
      }
    }).catch((error: unknown) => {
      if (request !== replayRequest.current) return;
      setReplay(null);
      setReplayError(error instanceof Error ? error.message : "本场 JSONL 回看读取失败。");
    }).finally(() => {
      if (request === replayRequest.current) setReplayLoading(false);
    });
  }, [bridge, pinnedSessionId, session?.state, session?.persistence, session?.replayFile, session?.sessionId]);

  async function checkHealth() {
    if (!bridge) return;
    const request = ++healthRequest.current;
    setAsrHealth(null);
    setHealthChecking(true);
    try {
      const health = await bridge.checkAsr(asrId);
      if (request === healthRequest.current) setAsrHealth(health);
    } catch (error) {
      if (request === healthRequest.current) {
        setAsrHealth({
          ok: false,
          detail: summarizeDiagnostic(error instanceof Error ? error.message : "") || "识别服务健康预检失败。",
        });
      }
    } finally {
      if (request === healthRequest.current) setHealthChecking(false);
    }
  }

  async function start() {
    if (!bridge) return;
    if (xfyunStartBlockReason(asrId, xfyunSecret ? xfyunSecret.configured : null)) return;
    if (healthChecking || asrHealth?.ok !== true) return;
    const streamTarget = source === "stream" ? normalizeDouyinLiveUrl(streamUrl) : null;
    if (source === "stream" && (!streamTarget || !streamTarget.ok)) {
      setLocalError(streamTarget && !streamTarget.ok ? streamTarget.message : "请先粘贴抖音直播间链接。");
      return;
    }
    setBusy(true);
    setLocalError(null);
    replayRequest.current += 1;
    catalogRequest.current += 1;
    setPinnedSessionId(null);
    setReplay(null);
    setReplayError(null);
    setPinnedIssueId(null);
    setProductNote("");
    setCurrentStageId(null);
    try {
      if (source === "loopback") {
        const video = videoRef.current;
        if (!video) throw new Error("缺少视频锚点，无法保持环回音轨。");
        stopPipe.current?.();
        stopStream(captureStream.current);
        captureStream.current = await primeLoopbackCapture(video);
        armed.current = captureStream.current;
      } else {
        releaseCapture();
      }
      const snapshot = await bridge.startSession({
        audioSource: source,
        asrId,
        demoScript,
        ...(streamTarget && streamTarget.ok ? { streamUrl: streamTarget.url } : {}),
      });
      setSession(snapshot);
      if (snapshot.state === "error" || snapshot.state === "completed") {
        releaseCapture();
        await syncStreamWindowVisible();
      }
    } catch (error) {
      releaseCapture();
      await syncStreamWindowVisible();
      setLocalError(error instanceof Error ? error.message : "开始失败");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!bridge) return;
    setBusy(true);
    try {
      const snapshot = await bridge.stopSession();
      setSession(snapshot);
      setProductNote("");
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "停止失败");
    } finally {
      releaseCapture();
      await syncStreamWindowVisible();
      setBusy(false);
    }
  }

  async function toggleStreamWindow() {
    if (!bridge) return;
    try {
      const result = await bridge.setStreamWindowVisible(!streamWindowVisible);
      setStreamWindowVisible(result.visible);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "切换直播画面失败。");
    }
  }

  async function syncStreamWindowVisible() {
    if (!bridge) return;
    const state = await bridge.getStreamWindowVisible();
    setStreamWindowVisible(state.visible);
  }

  function releaseCapture() {
    stopPipe.current?.();
    stopPipe.current = null;
    stopStream(captureStream.current);
    captureStream.current = null;
    armed.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  async function saveSettings(
    patch: { windowMs: number; intervalMs: number } | { streamAudible: boolean },
  ): Promise<SettingsUpdateResult> {
    if (!bridge || !settings) {
      return {
        ok: false,
        code: "invalid",
        message: "设置还没准备好。",
        settings: settings ?? {
          windowMs: 300_000,
          intervalMs: 60_000,
          windowMsRange: [60_000, 900_000],
          intervalMsRange: [15_000, 300_000],
          windowEditable: true,
          intervalEditable: true,
          persisted: false,
          note: "",
          streamAudible: false,
          asrOptions: [],
          reconnect: { backoffMs: [], maxAttempts: 0, autoReconnect: true },
        },
      };
    }
    const result = await bridge.updateSettings(patch);
    setSettings(result.settings);
    return result;
  }

  async function saveStreamAudible(audible: boolean): Promise<SettingsUpdateResult> {
    return saveSettings({ streamAudible: audible });
  }

  async function clearDeprecatedCloudKey(): Promise<SecretStatus> {
    if (!bridge) return unavailableSecretStatus();
    return bridge.clearCloudAsrKey();
  }

  async function setXfyunCredentials(credentials: { appId: string; apiKey: string }): Promise<SecretStatus> {
    if (!bridge) {
      return unavailableSecretStatus();
    }
    const status = await bridge.setXfyunCredentials(credentials);
    setXfyunSecret(status);
    return status;
  }

  async function clearXfyunCredentials(): Promise<SecretStatus> {
    if (!bridge) {
      return unavailableSecretStatus();
    }
    const status = await bridge.clearXfyunCredentials();
    setXfyunSecret(status);
    return status;
  }

  async function selectFramework() {
    if (!bridge) return;
    const result = await bridge.selectFramework();
    if (!result.ok && result.code === "session_active") {
      setLocalError(result.message);
      return;
    }
    setFramework(result);
    if (!result.ok) setLocalError(result.message);
  }

  function refreshCatalog() {
    if (!bridge) return;
    const request = ++catalogRequest.current;
    setCatalogLoading(true);
    setCatalogError(null);
    void bridge.listReplaySessions().then((result) => {
      if (request !== catalogRequest.current) return;
      if (result.ok) {
        setCatalog(result.sessions);
        setCatalogTruncated(result.truncated);
        setCatalogError(null);
      } else {
        setCatalog([]);
        setCatalogTruncated(false);
        setCatalogError(result.message);
      }
    }).catch((error: unknown) => {
      if (request !== catalogRequest.current) return;
      setCatalog([]);
      setCatalogTruncated(false);
      setCatalogError(error instanceof Error ? error.message : "历史场次读不出来。");
    }).finally(() => {
      if (request === catalogRequest.current) setCatalogLoading(false);
    });
  }

  function openCatalogSession(sessionId: string) {
    if (!bridge || locked) return;
    const request = ++replayRequest.current;
    setPinnedSessionId(sessionId);
    setReplay(null);
    setReplayLoading(true);
    setReplayError(null);
    void bridge.loadReplayBySessionId(sessionId).then((result) => {
      if (request !== replayRequest.current) return;
      if (result.ok) setReplay(result.replay);
      else {
        setReplay(null);
        setReplayError(result.message);
      }
    }).catch((error: unknown) => {
      if (request !== replayRequest.current) return;
      setReplay(null);
      setReplayError(error instanceof Error ? error.message : "这场 JSONL 回看读取失败。");
    }).finally(() => {
      if (request === replayRequest.current) setReplayLoading(false);
    });
  }

  function backToCurrentReplay() {
    setPinnedSessionId(null);
  }

  async function renameCatalogSession(sessionId: string, title: string): Promise<{ ok: boolean; message?: string }> {
    if (!bridge) return { ok: false, message: "桥还没准备好。" };
    const result = await bridge.renameReplaySession({ sessionId, title });
    if (result.ok) {
      setCatalog((current) =>
        current.map((entry) => (entry.sessionId === sessionId ? result.entry : entry)),
      );
      return { ok: true };
    }
    return { ok: false, message: result.message };
  }

  function leaveHistory() {
    catalogRequest.current += 1;
    replayRequest.current += 1;
    setPinnedSessionId(null);
    setReplay(null);
    setReplayError(null);
    setReplayLoading(false);
  }

  /** 复盘页「再盯一场」：只切回盯播主屏，由主播在主屏手动开始。 */
  function prepareRematch() {
    replayRequest.current += 1;
    catalogRequest.current += 1;
    setPinnedSessionId(null);
    setReplay(null);
    setReplayError(null);
    setReplayLoading(false);
    setWorkspace("monitor");
  }

  function applyAnalysis(next: { issues: Issue[]; unreadCount: number; pinnedIssueId?: string | null }) {
    setIssues(next.issues);
    setUnreadCount(next.unreadCount);
    if (next.pinnedIssueId !== undefined) setPinnedIssueId(next.pinnedIssueId);
  }

  function markRead(id: string) {
    if (!bridge) return;
    void bridge.markIssueRead({ id }).then(applyAnalysis);
  }

  function markAllRead() {
    if (!bridge) return;
    void bridge.markIssueRead({ all: true }).then(applyAnalysis);
  }

  function pinIssue(issueId: string) {
    if (!bridge) return;
    setPinnedIssueId(issueId);
    void bridge.setStage({ pinIssueId: issueId });
  }

  function unpinIssue() {
    if (!bridge) return;
    setPinnedIssueId(null);
    void bridge.setStage({ clearPin: true });
  }

  function dismissIssue(issueId: string) {
    if (!bridge) return;
    if (pinnedIssueId === issueId) setPinnedIssueId(null);
    void bridge.setStage({ dismissIssueId: issueId });
  }

  function setStage(stageId: string) {
    if (!bridge) return;
    setCurrentStageId(stageId);
    void bridge.setStage({ stageId });
  }

  function changeProductNote(value: string) {
    setProductNote(value);
    if (!bridge) return;
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => {
      void bridge.setStage({ productNote: value.trim() ? value : null });
    }, 300);
  }

  async function openStageWindow() {
    if (!bridge || selectedDisplayId == null) return;
    setStageMessage(null);
    const result = await bridge.openStage({ displayId: selectedDisplayId, mode: stageMode });
    if (!result.ok) {
      setStageMessage(result.message ?? "打开抬头屏失败。");
      toast("error", "抬头屏打开失败，盯播还在。");
    }
  }

  async function closeStageWindow() {
    if (!bridge) return;
    await bridge.closeStage();
    setStageMessage(null);
  }

  function changeDisplay(displayId: number) {
    setSelectedDisplayId(displayId);
    void persistStagePreferences({ displayId, mode: stageMode });
  }

  function changeStageMode(mode: "window" | "fullscreen") {
    setStageMode(mode);
    void persistStagePreferences({ displayId: selectedDisplayId, mode });
  }

  async function persistStagePreferences(next: StagePreferences) {
    if (!bridge) return;
    await bridge.saveStagePreferences(next);
  }

  async function refreshStageDisplays() {
    if (!bridge) return;
    const displays = await bridge.listStageDisplays();
    setStageDisplays(displays);
    if (displays.length > 0 && !displays.some((d) => d.id === selectedDisplayId)) {
      const fallback = displays.find((display) => display.internal) ?? displays[0];
      setSelectedDisplayId(fallback.id);
      await persistStagePreferences({ displayId: fallback.id, mode: stageMode });
      toast("warn", "上次使用的抬头屏未连接，已改选主屏。");
    }
  }

  const state = session?.state ?? "idle";
  const locked = state === "preparing" || state === "running" || state === "degraded" || state === "stopping";
  const currentReadable = session?.state === "completed" && session.persistence === "jsonl";
  const startGate = startControlState({
    asrId,
    frameworkOk: framework?.ok === true,
    busy,
    stopping: state === "stopping",
    xfyunConfigured: xfyunSecret ? xfyunSecret.configured : null,
    asrHealth,
    healthChecking,
  });
  const streamTarget = normalizeDouyinLiveUrl(streamUrl);
  const streamUrlHint =
    source === "stream" && streamUrl.trim() !== "" && !streamTarget.ok ? streamTarget.message : null;
  const streamBlockReason =
    source === "stream" && !streamTarget.ok
      ? streamUrl.trim() === ""
        ? "请先粘贴抖音直播间链接，示例：https://live.douyin.com/295178185857"
        : streamTarget.message
      : null;
  const startBlockReason = startGate.reason ?? streamBlockReason;
  const startDisabled = startGate.disabled || streamBlockReason !== null;

  function openIssueRules() {
    setWorkspace("settings");
    requestAnimationFrame(() => {
      document.getElementById("settings-issues")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function changeWorkspace(next: Workspace) {
    setWorkspace(next);
    if (next === "replay") refreshCatalog();
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className={state === "running" ? "lamp live" : "lamp"} />
          <div>
            <strong>AI盯播</strong>
            <small>中控台</small>
          </div>
        </div>
        <WorkspaceTabs value={workspace} onChange={changeWorkspace} />
        <div className="topbar-meta">
          {workspace === "replay" ? <span className="pill">JSONL 只读</span> : null}
          <span className={unreadCount > 0 ? "pill badge-pill hot" : "pill badge-pill"} aria-label={`${unreadCount} 条未读问题`}>
            {unreadCount} 未读
          </span>
          <span className={`pill state-${state}`}>{STATE_LABEL[state] ?? state}</span>
        </div>
      </header>
      {!bridge ? (
        <p className="banner bad page-note">这个页面需要在 Electron 里打开。浏览器里没有预加载桥，不能盯播。</p>
      ) : null}

      <main className="workspace-main">
        {workspace === "monitor" ? (
          <ControlWorkspace
            devices={devices}
            session={session}
            framework={framework}
            finals={finals}
            partial={partial}
            presentation={presentation}
            rms={rms}
            clockMs={clockMs}
            source={source}
            asrId={asrId}
            demoScript={demoScript}
            streamUrl={streamUrl}
            streamUrlError={streamUrlHint}
            streamWindowVisible={streamWindowVisible}
            streamWindowReady={streamWindowVisible || locked}
            busy={busy}
            localError={localError}
            issues={issues}
            unreadCount={unreadCount}
            coverage={coverage}
            qualityWarning={qualityWarning}
            lastAnalysis={lastAnalysis}
            asrHealth={asrHealth}
            healthChecking={healthChecking}
            startBlockReason={startBlockReason}
            startDisabled={startDisabled}
            productNote={productNote}
            noteDisabled={state === "preparing" || state === "stopping"}
            pinnedIssueId={pinnedIssueId}
            issueRuleProfileName={issueRuleProfileName}
            stageDisplays={stageDisplays}
            selectedDisplayId={selectedDisplayId}
            stageMode={stageMode}
            stageMessage={stageMessage}
            currentStageId={currentStageId}
            onSource={setSource}
            onStreamUrl={setStreamUrl}
            onToggleStreamWindow={() => void toggleStreamWindow()}
            onAsr={setAsrId}
            onDemoScript={setDemoScript}
            onSelectFramework={() => void selectFramework()}
            onCheckHealth={() => void checkHealth()}
            onStart={() => void start()}
            onStop={() => void stop()}
            onMarkRead={markRead}
            onMarkAllRead={markAllRead}
            onPinIssue={pinIssue}
            onUnpinIssue={unpinIssue}
            onDismissIssue={dismissIssue}
            onOpenIssueRules={openIssueRules}
            onSetStage={setStage}
            onProductNote={changeProductNote}
            onSelectDisplay={changeDisplay}
            onSelectStageMode={changeStageMode}
            onOpenStage={() => void openStageWindow()}
            onCloseStage={() => void closeStageWindow()}
            onRefreshDisplays={() => void refreshStageDisplays()}
          />
        ) : workspace === "replay" ? (
          <ReplayWorkspace
            locked={locked}
            catalog={catalog}
            loading={catalogLoading}
            error={catalogError}
            truncated={catalogTruncated}
            activeSessionId={pinnedSessionId ?? replay?.summary.sessionId ?? null}
            replay={replay}
            replayLoading={replayLoading}
            replayError={replayError}
            hasCurrent={currentReadable}
            showCurrent={pinnedSessionId != null && currentReadable && pinnedSessionId !== session?.sessionId}
            presentation={presentationForReplay(pinnedSessionId, session?.sessionId, presentation)}
            onSelect={openCatalogSession}
            onRename={renameCatalogSession}
            onBackToCurrent={backToCurrentReplay}
            onRematch={prepareRematch}
            onRefresh={refreshCatalog}
          />
        ) : (
          <SettingsWorkspace
            settings={settings}
            xfyunSecret={xfyunSecret}
            framework={framework}
            locked={locked}
            version={APP_VERSION}
            onSave={saveSettings}
            onStreamAudible={saveStreamAudible}
            onClearDeprecatedCloudKey={clearDeprecatedCloudKey}
            onSetXfyunCredentials={setXfyunCredentials}
            onClearXfyunCredentials={clearXfyunCredentials}
          />
        )}
      </main>

      <StatusBar
        stateLabel={STATE_LABEL[state] ?? state}
        stateTone={state === "error" ? "error" : state === "running" || state === "degraded" ? "running" : state === "completed" ? "done" : "idle"}
        clock={formatClock(clockMs)}
        sourceLabel={source === "loopback" ? "系统环回" : source === "stream" ? "抖音直播流" : "模拟音频"}
        asrLabel={asrId === "fake" ? "Fake ASR" : asrId === "funasr" ? "FunASR" : "讯飞 RTASR"}
        persistenceLabel={session?.persistence === "jsonl" ? "落盘 JSONL" : "仅内存"}
        unreadCount={unreadCount}
        note={localError}
      />
      <ToastHost toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((item) => item.id !== id))} />
      <video ref={videoRef} className="loopback-anchor" muted autoPlay playsInline />
    </div>
  );
}

function unavailableSecretStatus(): SecretStatus {
  return {
    configured: false,
    source: "none",
    backend: "unavailable",
    editable: false,
    devFallback: false,
    message: "设置还没准备好。",
  };
}
