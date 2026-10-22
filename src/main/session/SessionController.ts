import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { AUDIO, ASR_LANGUAGE, QUALITY_GATES, RECONNECT } from "@shared/config/defaults";
import { punctuationDisplayConfig, type PunctuationDisplayConfig } from "@shared/config/punctuation";
import type { AsrAdapter, AsrId } from "@shared/contracts/asr";
import type { AudioFrame, AudioSourceId, PcmChunkPayload } from "@shared/contracts/audio";
import type { FrameworkDocument, FrameworkItem, FrameworkStage } from "@shared/contracts/framework";
import type {
  AnalysisDigest,
  AnalysisSnapshot,
  CoverageItem,
  CoverageUpdatedEvent,
  IssueRecurrence,
  IssuesUpdatedEvent,
} from "@shared/contracts/issue";
import {
  defaultIssueRuleProfile,
  type IssueRuleActionResult,
  type IssueRuleProfile,
  type IssueRuleProfilesState,
} from "@shared/contracts/issueRules";
import type { SessionCatalogResult, SessionRenameResult, SessionReplayResult } from "@shared/contracts/replay";
import type { SessionSnapshot, SessionStartOptions } from "@shared/contracts/session";
import type { CaptionPresentation, TranscriptDelta, TranscriptView } from "@shared/contracts/transcript";
import type { AudioLevelEvent } from "@shared/contracts/ipc";
import type { StageView } from "@shared/contracts/stage";
import { IssueStore } from "../analysis/IssueStore";
import { IssueRuleProfiles } from "../analysis/IssueRuleProfiles";
import { customRuleHotwords, customRuleItems, effectiveFramework } from "../analysis/effectiveRules";
import { XfyunServiceError } from "../asr/xfyunProtocol";
import { analyzeWindow, assessGates, initialRuleState, type RuleState } from "../analysis/RuleEngine";
import { ActionSignals } from "../actions/ActionSignals";
import { ActionStorage } from "../actions/storage";
import type { ActionResolveRequest, ActionResult, ActionsSnapshot } from "@shared/contracts/actions";
import { WindowScheduler, type AnalysisRequest } from "../analysis/WindowScheduler";
import { AudioPumpError, type AudioPump } from "../audio/types";
import { FrameworkStore, defaultFrameworkPath } from "../framework/FrameworkStore";
import { logEvent } from "../security/log";
import { analysisTiming } from "../settings";
import { TranscriptBuffer } from "../transcript/TranscriptBuffer";
import { DisplayPunctuationScheduler, type DisplayPunctuator } from "@shared/transcript/punctuationPass";
import { summarizeDiagnostic } from "@shared/text/diagnostics";
import { PERSISTENCE_NOTE, PERSISTENCE_NOTE_FAILED } from "./SessionStore";
import { canAcceptStart, transition } from "./machine";
import { SessionJournal, listSessionReplays, readCurrentSessionReplay, readSessionReplayById, renameSessionReplay, writeSessionReplay, type ReplayEvent, type ReplayWriteResult } from "./replay";
import { SessionProjection, type ProjectionInput } from "./SessionProjection";

export type SessionControllerDeps = {
  createAsr: (id: AsrId, options: SessionStartOptions) => AsrAdapter;
  createPump: (source: AudioSourceId, options: SessionStartOptions) => AudioPump;
  frameworks?: FrameworkStore;
  getReplayRoot?: () => string;
  writeReplay?: (root: string, sessionId: string, events: readonly ReplayEvent[]) => ReplayWriteResult;
  /** 展示层标点节奏。不写入设置页，测试可覆盖。 */
  punctuation?: Partial<PunctuationDisplayConfig>;
};

type ReconnectKind = "audio" | "asr";

type ReconnectPlan = {
  kind: ReconnectKind;
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

const EMPTY_VIEW: TranscriptView = { sessionId: null, finals: [], partial: null };

export class SessionController {
  private state: SessionSnapshot["state"] = "idle";
  private sessionId: string | null = null;
  private audioSource: AudioSourceId | null = null;
  private asrId: AsrId | null = null;
  private error: SessionSnapshot["error"] = null;
  private guidance: string | null = null;
  private phaseDetail: string | null = null;
  private startedAtIso: string | null = null;
  private audioClockMs = 0;
  private degradedReason: string | null = null;
  private stopWarning: string | null = null;
  private buffer: TranscriptBuffer | null = null;
  private pump: AudioPump | null = null;
  private asr: AsrAdapter | null = null;
  private pending: AudioFrame[] = [];
  private lastFrameAt = 0;
  private lastLevelAt = 0;
  private cancelStart = false;
  private startPromise: Promise<SessionSnapshot> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private stateListeners = new Set<(snapshot: SessionSnapshot) => void>();
  private transcriptListeners = new Set<(delta: TranscriptDelta) => void>();
  private presentationListeners = new Set<(event: CaptionPresentation) => void>();
  private levelListeners = new Set<(level: AudioLevelEvent) => void>();
  private issueListeners = new Set<(event: IssuesUpdatedEvent) => void>();
  private coverageListeners = new Set<(event: CoverageUpdatedEvent) => void>();
  private stageListeners = new Set<(view: StageView) => void>();
  private readonly frameworks: FrameworkStore;
  private readonly issues = new IssueStore();
  private readonly issueRuleProfiles: IssueRuleProfiles;
  private issueRuleSnapshot: { profile: IssueRuleProfile; customItems: FrameworkItem[] } | null = null;
  private activeIssueRuleProfileName: string | null = null;
  private pendingRecurrences: IssueRecurrence[] = [];
  private readonly lastRecurrenceReminderAt = new Map<string, number>();
  private frameworkSnapshot: { revision: string; document: FrameworkDocument } | null = null;
  private ruleState: RuleState = initialRuleState({ pace: { min: 1, max: 1, unit: "chars_per_minute" }, must_say: [], avoid: [] });
  private scheduler: WindowScheduler | null = null;
  private qualityStreak = 0;
  private qualityWarning: string | null = null;
  private lastAnalysis: AnalysisDigest | null = null;
  private frameworkTitle: string | null = null;
  private frameworkRevision: string | null = null;
  private journal: SessionJournal | null = null;
  private persistence: SessionSnapshot["persistence"] = "memory";
  private persistenceNote = PERSISTENCE_NOTE;
  private replayFile: string | null = null;
  private reconnect: ReconnectPlan | null = null;
  private asrPaused = false;
  private unbindAsr: (() => void) | null = null;
  private punctuationPauseLogged = false;
  private readonly displayPunctuation: DisplayPunctuationScheduler;
  private readonly projection = new SessionProjection();
  readonly actions: ActionSignals;

  constructor(deps: SessionControllerDeps) {
    this.deps = deps;
    this.actions = new ActionSignals(new ActionStorage(() => this.replayRoot()));
    this.issueRuleProfiles = new IssueRuleProfiles(() => this.replayRoot());
    this.displayPunctuation = new DisplayPunctuationScheduler(
      punctuationDisplayConfig(process.env, deps.punctuation),
      (overlay, paused) => this.emitPresentation(overlay, paused),
      () => this.displayPunctuator(),
    );
    this.frameworks = deps.frameworks ?? new FrameworkStore();
    if (!deps.frameworks) this.frameworks.loadFile(defaultFrameworkPath());
    this.scheduler = new WindowScheduler({
      getWindowMs: () => analysisTiming().windowMs,
      getIntervalMs: () => analysisTiming().intervalMs,
      onAnalyze: (request) => this.runAnalysis(request),
      onOverrun: (audioClockMs) => {
        logEvent("warn", "analysis", "analysis_overrun", { sessionId: this.sessionId, audioClockMs });
      },
    });
  }

  private readonly deps: SessionControllerDeps;

  snapshot(): SessionSnapshot {
    return {
      sessionId: this.sessionId,
      state: this.state,
      audioSource: this.audioSource,
      asrId: this.asrId,
      error: this.error,
      guidance: this.guidance,
      phaseDetail: this.phaseDetail,
      startedAtIso: this.startedAtIso,
      audioClockMs: this.audioClockMs,
      degradedReason: this.degradedReason,
      stopWarning: this.stopWarning,
      persistence: this.persistence,
      persistenceNote: this.persistenceNote,
      replayFile: this.replayFile,
      reconnectAttempt: this.reconnect?.attempt ?? null,
      reconnectMaxAttempts: this.reconnect ? RECONNECT.maxAttempts : null,
      frameworkTitle: this.frameworkTitle,
      frameworkRevision: this.frameworkRevision,
      unreadCount: this.issues.unreadCount(),
      qualityWarning: this.qualityWarning,
    };
  }

  analysisSnapshot(): AnalysisSnapshot {
    return {
      issues: this.issues.list(),
      unreadCount: this.issues.unreadCount(),
      coverage: this.coverageView(),
      qualityWarning: this.qualityWarning,
      lastAnalysis: this.lastAnalysis ? { ...this.lastAnalysis } : null,
      pinnedIssueId: this.projection.current(this.projectionInput()).pinnedIssueId,
      issueRuleProfileName: this.currentIssueRuleProfileName(),
    };
  }

  getTranscript(): TranscriptView {
    const view = this.buffer?.view() ?? EMPTY_VIEW;
    return { ...view, presentation: this.displayPunctuation.overlay() };
  }

  currentReplay(): SessionReplayResult {
    const canRead = this.state === "completed" && this.persistence === "jsonl";
    return this.withActionHistory(readCurrentSessionReplay(this.replayFile, canRead));
  }

  listReplaySessions(): SessionCatalogResult {
    return listSessionReplays(this.replayRoot());
  }

  loadReplayBySessionId(sessionId: string): SessionReplayResult {
    return this.withActionHistory(readSessionReplayById(this.replayRoot(), sessionId));
  }

  private withActionHistory(result: SessionReplayResult): SessionReplayResult {
    if (!result.ok) return result;
    const sessionId = result.replay.summary.sessionId;
    const memory = this.actions.snapshot();
    const history = sessionId === memory.sessionId && memory.warning?.includes("写入失败")
      ? { signals: memory.signals, warning: `${memory.warning} 当前显示本场内存记录。` }
      : this.actions.storage.history(sessionId);
    return { ok: true, replay: { ...result.replay, actionHistory: history } };
  }

  renameReplaySession(sessionId: string, title: string): SessionRenameResult {
    return renameSessionReplay(this.replayRoot(), sessionId, title);
  }

  /** 当前 StageView 投影。 */
  stageView(): StageView {
    return this.projection.stageView(this.projectionInput());
  }

  actionSnapshot(): ActionsSnapshot {
    const snapshot = this.actions.snapshot();
    return { ...snapshot, signals: this.projection.current(this.projectionInput()).actionSignals };
  }

  saveActionConfig(raw: unknown): ActionResult {
    if (["preparing", "running", "degraded", "stopping"].includes(this.state)) {
      return { ok: false, message: "盯播进行中不能修改动作规则。" };
    }
    return this.actions.saveConfig(raw, this.frameworks.current());
  }

  issueRuleProfilesState(): IssueRuleProfilesState {
    return this.issueRuleProfiles.state();
  }

  saveIssueRuleProfile(raw: unknown): IssueRuleActionResult {
    if (this.issueRulesLocked()) return { ok: false, message: "盯播进行中不能修改问题警告方案。", state: this.issueRuleProfiles.state() };
    const result = this.issueRuleProfiles.save(raw);
    if (result.ok) this.activeIssueRuleProfileName = activeNameOf(result.state);
    return result;
  }

  deleteIssueRuleProfile(id: string): IssueRuleActionResult {
    if (this.issueRulesLocked()) return { ok: false, message: "盯播进行中不能修改问题警告方案。", state: this.issueRuleProfiles.state() };
    const result = this.issueRuleProfiles.remove(id);
    if (result.ok) this.activeIssueRuleProfileName = activeNameOf(result.state);
    return result;
  }

  activateIssueRuleProfile(id: string): IssueRuleActionResult {
    if (this.issueRulesLocked()) return { ok: false, message: "盯播进行中不能修改问题警告方案。", state: this.issueRuleProfiles.state() };
    const result = this.issueRuleProfiles.activate(id);
    if (result.ok) this.activeIssueRuleProfileName = activeNameOf(result.state);
    return result;
  }

  private issueRulesLocked(): boolean {
    return ["preparing", "running", "degraded", "stopping"].includes(this.state);
  }

  private currentIssueRuleProfileName(): string | null {
    if (this.activeIssueRuleProfileName) return this.activeIssueRuleProfileName;
    this.activeIssueRuleProfileName = this.issueRuleProfiles.activeProfile().name;
    return this.activeIssueRuleProfileName;
  }

  resolveAction(request: ActionResolveRequest): ActionResult {
    return this.actions.resolve(request, this.state === "running");
  }

  onState(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onTranscript(listener: (delta: TranscriptDelta) => void): () => void {
    this.transcriptListeners.add(listener);
    return () => this.transcriptListeners.delete(listener);
  }

  onPresentation(listener: (event: CaptionPresentation) => void): () => void {
    this.presentationListeners.add(listener);
    return () => this.presentationListeners.delete(listener);
  }

  onLevel(listener: (level: AudioLevelEvent) => void): () => void {
    this.levelListeners.add(listener);
    return () => this.levelListeners.delete(listener);
  }

  onIssues(listener: (event: IssuesUpdatedEvent) => void): () => void {
    this.issueListeners.add(listener);
    return () => this.issueListeners.delete(listener);
  }

  onCoverage(listener: (event: CoverageUpdatedEvent) => void): () => void {
    this.coverageListeners.add(listener);
    return () => this.coverageListeners.delete(listener);
  }

  onStage(listener: (view: StageView) => void): () => void {
    this.stageListeners.add(listener);
    return () => this.stageListeners.delete(listener);
  }

  /** Control 点选阶段。 */
  setStageId(stageId: string | null): void {
    const stages = this.frameworkSnapshot?.document.stages;
    if (stageId !== null && !stages?.some(stage => stage.id === stageId)) return;
    const previous = this.projection.current(this.projectionInput()).stageId ?? stages?.[0]?.id ?? null;
    const next = stageId ?? stages?.[0]?.id ?? null;
    if (previous !== next) this.actions.invalidate("当前阶段已改变");
    this.projection.setStageId(stageId);
    this.emitStage();
  }

  /** Control pin 一条未读问题到 Stage。已读问题不生效。 */
  pinIssue(issueId: string | null): void {
    if (issueId !== null && !this.issues.list().some((issue) => issue.id === issueId && issue.status === "unread")) {
      return;
    }
    this.projection.setPinnedIssueId(issueId);
    this.emitStage();
  }

  /** Control 取消 pin，回到自动建议。 */
  unpinIssue(): void {
    this.projection.setPinnedIssueId(null);
    this.emitStage();
  }

  /** Control dismiss 一条问题，Stage 跳过它。 */
  dismissIssue(issueId: string): void {
    this.projection.dismissIssue(issueId);
    this.emitStage();
  }

  /** Control 手填品备注。 */
  setProductNote(note: string | null): void {
    this.projection.setProductNote(note);
    this.emitStage();
  }

  /** 当前框架 stages（只读）。 */
  frameworkStages(): FrameworkStage[] | undefined {
    return this.frameworkSnapshot?.document.stages;
  }

  markIssueRead(id: string): void {
    this.issues.markRead(id);
    this.emitAnalysis();
    if (this.state === "running" || this.state === "degraded" || this.state === "completed") this.emitState();
    this.emitStage();
  }

  markAllIssuesRead(): void {
    this.issues.markAllRead();
    this.emitAnalysis();
    if (this.state === "running" || this.state === "degraded" || this.state === "completed") this.emitState();
    this.emitStage();
  }

  start(options: SessionStartOptions): Promise<SessionSnapshot> {
    if (this.startPromise) return this.startPromise;
    if (!canAcceptStart(this.state)) return Promise.resolve(this.snapshot());
    this.startPromise = this.startInner(options).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async stop(): Promise<SessionSnapshot> {
    if (this.state === "idle" || this.state === "completed") return this.snapshot();
    if (this.state === "stopping") return this.snapshot();
    if (this.state === "error" && this.persistence === "jsonl") return this.snapshot();
    if (this.state === "preparing") {
      this.cancelStart = true;
      this.phaseDetail = "正在取消";
      await this.pump?.stop();
      await this.startPromise;
      return this.snapshot();
    }
    return this.finishActiveSession();
  }

  ingestChunk(chunk: PcmChunkPayload): void {
    if (!this.sessionId || chunk.sessionId !== this.sessionId) return;
    if (this.state !== "preparing" && this.state !== "running" && this.state !== "degraded") return;
    this.pump?.ingest?.(chunk);
  }

  notifyCaptureFailed(sessionId: string, message: string): void {
    if (!this.sessionId || sessionId !== this.sessionId) return;
    this.pump?.failCapture?.(message);
  }

  private async startInner(options: SessionStartOptions): Promise<SessionSnapshot> {
    this.cancelStart = false;
    if (this.state === "completed" || this.state === "error") {
      if (this.persistence !== "jsonl") this.flushReplay("superseded");
      this.state = transition(this.state, "RESET");
      this.clearEphemeral();
    }
    this.sessionId = randomUUID();
    this.actions.begin(this.sessionId, this.frameworks.current());
    this.audioSource = options.audioSource;
    this.asrId = options.asrId;
    this.startedAtIso = new Date().toISOString();
    this.audioClockMs = 0;
    this.error = null;
    this.degradedReason = null;
    this.stopWarning = null;
    this.pending = [];
    this.buffer = new TranscriptBuffer(this.sessionId);
    this.issues.reset(this.sessionId);
    this.frameworkSnapshot = null;
    this.frameworkTitle = null;
    this.frameworkRevision = null;
    this.pendingRecurrences = [];
    this.lastRecurrenceReminderAt.clear();
    const ruleProfile = this.issueRuleProfiles.activeProfile();
    this.issueRuleSnapshot = { profile: structuredClone(ruleProfile), customItems: customRuleItems(ruleProfile) };
    this.activeIssueRuleProfileName = ruleProfile.name;
    this.journal = new SessionJournal(this.sessionId);
    this.journal.append("session_started", {
      audioSource: options.audioSource,
      asrId: options.asrId,
      windowMs: analysisTiming().windowMs,
      intervalMs: analysisTiming().intervalMs,
    });
    this.persistence = "memory";
    this.replayFile = null;
    this.persistenceNote = PERSISTENCE_NOTE;
    this.asrPaused = false;
    this.qualityStreak = 0;
    this.qualityWarning = null;
    this.lastAnalysis = null;
    this.ruleState = initialRuleState({ pace: { min: 1, max: 1, unit: "chars_per_minute" }, must_say: [], avoid: [] });
    this.guidance =
      options.audioSource === "simulated" ? "模拟音频只验证字幕链路，不是系统环回成功。" : null;
    this.phaseDetail =
      options.audioSource === "loopback"
        ? "正在等待系统环回的第一帧音频"
        : options.audioSource === "stream"
          ? "正在打开抖音直播间并等待音频"
          : options.asrId === "funasr"
            ? "正在启动 FunASR（paraformer-zh-streaming，CPU）"
            : options.asrId === "xfyun"
              ? "正在连接讯飞 RTASR 云端。音频将发送至讯飞，请保持网络可用。"
              : "正在启动模拟音频";
    this.state = transition(this.state, "START");
    this.displayPunctuation.reset();
    this.emitTranscript({ sessionId: this.sessionId, kind: "reset" });
    this.emitAnalysis();
    this.emitState();
    this.emitStage();
    logEvent("info", "session", "preparing", { sessionId: this.sessionId, audioSource: options.audioSource, asrId: options.asrId });

    const loaded = this.frameworks.current();
    if (!loaded.ok) {
      this.error = { code: "framework_invalid", message: loaded.message };
      this.guidance = loaded.message;
      this.phaseDetail = loaded.message;
      this.state = transition(this.state, "INIT_FAILED");
      logEvent("error", "session", "framework_invalid", { sessionId: this.sessionId, message: loaded.message });
      this.emitState();
      this.emitStage();
      return this.snapshot();
    }
    const activeFramework = {
      revision: loaded.revision,
      document: effectiveFramework(loaded.document, ruleProfile),
    };
    this.frameworkSnapshot = activeFramework;
    this.frameworkTitle = loaded.document.title ?? loaded.document.id ?? "未命名框架";
    this.frameworkRevision = loaded.revision;
    this.ruleState = initialRuleState(activeFramework.document);
    this.journal?.append("framework_loaded", {
      revision: loaded.revision,
      title: this.frameworkTitle,
      id: loaded.document.id ?? null,
      mustSayIds: loaded.document.must_say.map((item) => item.id),
      avoidIds: loaded.document.avoid.map((item) => item.id),
      issueRuleProfileId: ruleProfile.id,
      issueRuleProfileName: ruleProfile.name,
    });
    this.emitAnalysis();
    this.emitStage();

    const pump = this.deps.createPump(options.audioSource, options);
    const asr = this.deps.createAsr(options.asrId, options);
    this.pump = pump;
    this.asr = asr;
    this.bindAsr(asr);

    try {
      pump.prepare();
      await asr.start({
        sessionId: this.sessionId,
        language: ASR_LANGUAGE,
        sampleRate: AUDIO.sampleRate,
        hotwords: mergeHotwords(hotwordsOf(activeFramework.document), customRuleHotwords(ruleProfile)),
      });
      if (this.cancelStart) throw new AudioPumpError("cancelled", "已取消");
      await pump.start(this.sessionId, {
        onFrame: (frame) => this.onFrame(frame),
        onCaptureError: (error) => this.onCaptureError(error),
      });
      if (this.state !== "preparing") return this.snapshot();
      this.lastFrameAt = Date.now();
      this.state = transition(this.state, "READY");
      this.phaseDetail =
        options.audioSource === "simulated"
          ? "模拟注入进行中。字幕来自固定脚本，不是真实识别。"
          : options.audioSource === "stream"
            ? "已收到直播流音频帧。"
            : "已收到环回音频帧。";
      this.scheduler?.start();
      this.flushPending();
      this.startWatchdog(pump);
      this.emitState();
      this.emitStage();
      logEvent("info", "session", "running", { sessionId: this.sessionId });
      return this.snapshot();
    } catch (error) {
      await this.cleanupMedia();
      if (this.state !== "preparing") return this.snapshot();
      const cancelled = this.cancelStart || (error instanceof AudioPumpError && error.code === "cancelled");
      if (cancelled) {
        const saved = this.flushReplay("cancelled");
        this.state = transition(this.state, "STOP");
        this.state = transition(this.state, "STOPPED_OK");
        this.phaseDetail = saved?.ok ? "已取消，复盘已写入。" : "已取消";
        this.guidance = this.audioSource === "simulated" ? this.guidance : null;
      } else {
        const detail = error instanceof Error ? error.message : "初始化失败";
        const message = summarizeDiagnostic(detail) || "初始化失败";
        const code = error instanceof AudioPumpError ? error.code : "asr_failed";
        this.error = { code, message };
        this.guidance = message;
        this.phaseDetail = message;
        this.state = transition(this.state, "INIT_FAILED");
        logEvent("error", "session", "init_failed", { sessionId: this.sessionId, code, detail });
      }
      this.emitState();
      this.emitStage();
      return this.snapshot();
    }
  }

  private async finishActiveSession(): Promise<SessionSnapshot> {
    this.cancelReconnect();
    this.stopWatchdog();
    this.scheduler?.stop();
    const from = this.state;
    if (from === "running" || from === "degraded" || from === "preparing" || from === "error") {
      this.state = transition(this.state, "STOP");
    }
    this.phaseDetail = "正在结束识别";
    this.emitState();
    this.emitStage();
    let replay: ReplayWriteResult = { ok: false, message: PERSISTENCE_NOTE_FAILED };
    try {
      await this.pump?.stop();
      await this.asr?.flush();
      await this.waitForPartial(5_000);
      await this.displayPunctuation.finish(this.buffer?.view().finals ?? []);
      const partialLeft = Boolean(this.buffer?.view().partial);
      this.scheduler?.finalFlush(this.audioClockMs);
      this.scheduler = this.replacedScheduler();
      this.journal?.append("session_stopped", {
        audioClockMs: this.audioClockMs,
        reason: "user_stop",
        partialLeft,
      });
      replay = this.writeReplay();
      this.rememberReplay(replay);
      await this.asr?.stop();
      this.pump = null;
      this.asr = null;
      this.unbindAsr?.();
      this.unbindAsr = null;
      if (!replay.ok) {
        this.error = { code: "replay_failed", message: replay.message };
        this.phaseDetail = replay.message;
        this.stopWarning = replay.message;
        if (this.state === "stopping") this.state = transition(this.state, "STOP_FAILED");
        logEvent("error", "session", "replay_failed", { sessionId: this.sessionId });
      } else {
        if (partialLeft) this.stopWarning = "停止时仍有未完成的临时字幕，已停止等待。";
        if (this.state === "stopping") this.state = transition(this.state, "STOPPED_OK");
        this.phaseDetail = "本场已结束，字幕仍可浏览。";
        logEvent("info", "session", "completed", { sessionId: this.sessionId, audioClockMs: this.audioClockMs });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "停止失败";
      if (!replay.ok) this.rememberReplay(this.writeReplay());
      this.error = { code: replay.ok ? "stop_failed" : "replay_failed", message: replay.ok ? message : replay.message };
      this.phaseDetail = this.error.message;
      this.stopWarning = replay.ok ? message : replay.message;
      if (this.state === "stopping") this.state = transition(this.state, "STOP_FAILED");
      logEvent("error", "session", "stop_failed", { sessionId: this.sessionId, message });
    }
    this.emitState();
    this.emitStage();
    return this.snapshot();
  }

  private bindAsr(asr: AsrAdapter): void {
    this.unbindAsr?.();
    const offResult = asr.onResult((result) => {
      if (!this.buffer) return;
      if (this.state !== "running" && this.state !== "degraded" && this.state !== "stopping") return;
      const applied = this.buffer.apply(result);
      if (applied.kind === "ignored" || !applied.segment || !this.sessionId) return;
      if (applied.kind === "final") {
        this.journal?.append("transcript_final", {
          id: applied.segment.id,
          startMs: applied.segment.startMs,
          endMs: applied.segment.endMs,
          text: applied.segment.text,
        });
        if (this.asrId === "funasr") this.displayPunctuation.noteFinal(applied.segment);
      }
      this.emitTranscript({ sessionId: this.sessionId, kind: applied.kind, segment: applied.segment });
    });
    const offError = asr.onError((error) => {
      if (this.state === "running" || this.state === "degraded") this.enterDegraded(error.message, "asr");
    });
    this.unbindAsr = () => {
      offResult();
      offError();
    };
  }

  private onFrame(frame: AudioFrame): void {
    this.lastFrameAt = Date.now();
    this.pending.push(frame);
    this.flushPending();
  }

  private flushPending(): void {
    if (this.state !== "running" && this.state !== "degraded") return;
    const frames = this.pending.splice(0);
    const asr = this.asr;
    for (const frame of frames) {
      const gap = this.buffer?.noteFrame(frame) ?? null;
      if (gap) this.journal?.append("audio_gap", gap);
      this.audioClockMs = frame.startMs + frame.durationMs;
      this.emitLevel(frame);
      if (!asr || this.asrPaused) continue;
      void asr.push(frame).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "ASR 推送失败";
        this.enterDegraded(message, "asr");
      });
    }
    if (frames.length > 0 && this.state === "degraded" && this.reconnect?.kind !== "asr") {
      this.recover(this.audioSource === "simulated" ? "模拟注入已恢复。" : "已重新收到音频帧。中断没有被当成静音。");
    }
    if (this.state === "running") this.scheduler?.tick(this.audioClockMs);
  }

  private onCaptureError(error: { code: string; message: string }): void {
    if (this.state === "running" || this.state === "degraded") {
      this.enterDegraded(error.message, "audio");
      return;
    }
    if (this.state === "preparing") {
      this.error = error;
      this.guidance = error.message;
      this.phaseDetail = error.message;
      this.state = transition(this.state, "INIT_FAILED");
      void this.cleanupMedia();
      this.emitState();
      this.emitStage();
    }
  }

  private enterDegraded(message: string, kind: ReconnectKind): void {
    if (this.state !== "running" && this.state !== "degraded") return;
    if (this.state === "running") this.state = transition(this.state, "DEGRADE");
    this.degradedReason = message;
    if (this.reconnect && this.reconnect.kind !== kind) {
      this.emitState();
      this.emitStage();
      return;
    }
    if (!this.reconnect) {
      this.reconnect = { kind, attempt: 0, timer: null };
      this.guidance =
        kind === "audio"
          ? "采音中断不会被当成静音。将按 1/2/4/8 秒重连，最多 5 次。"
          : "识别中断。将按 1/2/4/8 秒重连，最多 5 次。重连期间字幕可能有缺口，不会回放旧音频。";
      logEvent("warn", "session", "degraded", { sessionId: this.sessionId, message, kind });
      this.scheduleReconnect();
      return;
    }
    this.emitState();
    this.emitStage();
  }

  private scheduleReconnect(): void {
    if (this.state !== "degraded" || !this.reconnect) return;
    if (this.reconnect.timer) clearTimeout(this.reconnect.timer);
    this.reconnect.timer = null;
    if (this.reconnect.attempt >= RECONNECT.maxAttempts) {
      const noun = this.reconnect.kind === "audio" ? "采音" : "识别";
      void this.giveUp(`${noun}重连已超过 ${RECONNECT.maxAttempts} 次，不再自动恢复。`);
      return;
    }
    const delay = RECONNECT.backoffMs[Math.min(this.reconnect.attempt, RECONNECT.backoffMs.length - 1)] ?? 8_000;
    this.reconnect.attempt += 1;
    const noun = this.reconnect.kind === "audio" ? "采音" : "识别";
    this.phaseDetail = `${noun}中断，${delay / 1000} 秒后进行第 ${this.reconnect.attempt}/${RECONNECT.maxAttempts} 次重连。`;
    this.reconnect.timer = setTimeout(() => {
      void this.runReconnectAttempt();
    }, delay);
    this.emitState();
    this.emitStage();
  }

  private async runReconnectAttempt(): Promise<void> {
    if (this.state !== "degraded" || !this.reconnect) return;
    const kind = this.reconnect.kind;
    const noun = kind === "audio" ? "采音" : "识别";
    this.phaseDetail = `正在重连${noun}（第 ${this.reconnect.attempt}/${RECONNECT.maxAttempts} 次）。`;
    this.emitState();
    this.emitStage();
    try {
      if (kind === "audio") this.pump?.rearm?.();
      else {
        await this.restartAsr();
        if (this.state === "degraded") {
          this.recover("识别已重连。重连期间的字幕可能有缺口，不会回放旧音频。");
          return;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "重连失败";
      this.degradedReason = message;
      logEvent("warn", "session", "reconnect_failed", { sessionId: this.sessionId, attempt: this.reconnect?.attempt, message });
      if (error instanceof XfyunServiceError && !error.retryable) {
        await this.giveUp(`识别无法自动恢复：${message}`);
        return;
      }
    }
    if (this.state === "degraded") this.scheduleReconnect();
  }

  private async restartAsr(): Promise<void> {
    const asr = this.asr;
    const sessionId = this.sessionId;
    if (!asr || !sessionId) throw new Error("没有可重连的识别器");
    this.asrPaused = true;
    this.displayPunctuation.markCacheReset();
    try {
      this.unbindAsr?.();
      this.unbindAsr = null;
      await asr.stop();
      await asr.start({
        sessionId,
        language: ASR_LANGUAGE,
        sampleRate: AUDIO.sampleRate,
        hotwords: this.frameworkSnapshot ? hotwordsOf(this.frameworkSnapshot.document) : [],
      });
      this.bindAsr(asr);
    } finally {
      this.asrPaused = false;
    }
  }

  private recover(detail: string): void {
    if (this.state !== "degraded") return;
    this.cancelReconnect();
    this.state = transition(this.state, "RECOVER");
    this.degradedReason = null;
    this.phaseDetail = detail;
    this.guidance = detail;
    this.lastFrameAt = Date.now();
    logEvent("info", "session", "recovered", { sessionId: this.sessionId });
    this.emitState();
    this.emitStage();
  }

  private cancelReconnect(): void {
    if (this.reconnect?.timer) clearTimeout(this.reconnect.timer);
    this.reconnect = null;
  }

  private async giveUp(message: string): Promise<void> {
    if (this.state !== "degraded") return;
    this.cancelReconnect();
    this.stopWatchdog();
    this.scheduler?.stop();
    this.scheduler?.finalFlush(this.audioClockMs);
    this.journal?.append("session_stopped", { audioClockMs: this.audioClockMs, reason: "reconnect_exhausted" });
    const saved = this.writeReplay();
    this.rememberReplay(saved);
    this.error = { code: "reconnect_exhausted", message };
    this.degradedReason = message;
    this.phaseDetail = saved.ok ? `${message}复盘已写入。` : `${message}${saved.message}`;
    this.guidance = "重连次数已用完。本场字幕和问题仍可浏览。";
    if (!saved.ok) this.stopWarning = saved.message;
    if (this.state === "degraded") this.state = transition(this.state, "GIVE_UP");
    logEvent("error", "session", "reconnect_exhausted", { sessionId: this.sessionId, message });
    this.emitState();
    this.emitStage();
    await this.cleanupMedia();
  }

  private flushReplay(reason: string): ReplayWriteResult | null {
    if (!this.journal || this.persistence === "jsonl") return null;
    this.journal.append("session_stopped", { audioClockMs: this.audioClockMs, reason });
    const result = this.writeReplay();
    this.rememberReplay(result);
    return result;
  }

  private replayRoot(): string {
    return this.deps.getReplayRoot?.() ?? path.join(os.tmpdir(), "ai-dingbo");
  }

  private writeReplay(): ReplayWriteResult {
    const sessionId = this.sessionId;
    const journal = this.journal;
    if (!sessionId || !journal || journal.events.length === 0) {
      return { ok: false, message: PERSISTENCE_NOTE_FAILED };
    }
    try {
      const root = this.replayRoot();
      const write = this.deps.writeReplay ?? writeSessionReplay;
      return write(root, sessionId, journal.events);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "IO 错误";
      return { ok: false, message: `${PERSISTENCE_NOTE_FAILED}（${detail}）` };
    }
  }

  private rememberReplay(result: ReplayWriteResult): void {
    if (result.ok) {
      this.persistence = "jsonl";
      this.replayFile = result.filePath;
      this.persistenceNote = `已写入本机复盘 ${result.filePath}。不上传，也不保存原始音频。`;
      return;
    }
    this.persistence = "memory";
    this.replayFile = null;
    this.persistenceNote = result.message;
    this.stopWarning = result.message;
  }

  private startWatchdog(pump: AudioPump): void {
    this.stopWatchdog();
    if (!pump.monitorsLiveness) return;
    this.watchdog = setInterval(() => {
      if (this.state !== "running") return;
      if (Date.now() - this.lastFrameAt >= AUDIO.gapDegradeMs) {
        this.enterDegraded(`采音中断：连续 ${AUDIO.gapDegradeMs / 1000} 秒没有音频帧。`, "audio");
      }
    }, 500);
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private async waitForPartial(timeoutMs: number): Promise<void> {
    const started = Date.now();
    while (this.buffer?.view().partial && Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private async cleanupMedia(): Promise<void> {
    this.stopWatchdog();
    this.scheduler?.stop();
    const pump = this.pump;
    const asr = this.asr;
    this.pump = null;
    this.asr = null;
    await pump?.stop().catch(() => undefined);
    await asr?.stop().catch(() => undefined);
  }

  private clearEphemeral(): void {
    this.cancelReconnect();
    this.sessionId = null;
    this.audioSource = null;
    this.asrId = null;
    this.error = null;
    this.guidance = null;
    this.phaseDetail = null;
    this.startedAtIso = null;
    this.audioClockMs = 0;
    this.degradedReason = null;
    this.stopWarning = null;
    this.buffer = null;
    this.pending = [];
    this.frameworkSnapshot = null;
    this.frameworkTitle = null;
    this.frameworkRevision = null;
    this.issueRuleSnapshot = null;
    this.pendingRecurrences = [];
    this.lastRecurrenceReminderAt.clear();
    this.journal = null;
    this.persistence = "memory";
    this.persistenceNote = PERSISTENCE_NOTE;
    this.replayFile = null;
    this.asrPaused = false;
    this.unbindAsr?.();
    this.unbindAsr = null;
    this.displayPunctuation.reset();
    this.qualityWarning = null;
    this.qualityStreak = 0;
    this.lastAnalysis = null;
    this.issues.reset("");
    this.projection.resetEphemeral();
  }

  private runAnalysis(request: AnalysisRequest): void {
    const framework = this.frameworkSnapshot;
    const buffer = this.buffer;
    if (!framework || !buffer || !this.sessionId) return;
    if (!request.finalFlush && this.state !== "running") return;
    const started = performance.now();
    const ruleConfig = this.issueRuleSnapshot ?? {
      profile: defaultIssueRuleProfile(),
      customItems: [] as FrameworkItem[],
    };
    try {
      const snapshot = buffer.snapshot(request.endMs, request.windowMs, request.endMs, framework.revision);
      const output = analyzeWindow(
        snapshot,
        framework.document,
        this.ruleState,
        {
          nominalWindowMs: request.windowMs,
          intervalMs: analysisTiming().intervalMs,
          finalFlush: request.finalFlush,
          frameworkRevision: framework.revision,
        },
        ruleConfig.profile,
        ruleConfig.customItems,
      );
      this.ruleState = output.state;
      const stage = this.projection.current(this.projectionInput());
      this.actions.observe({
        sessionId: this.sessionId,
        running: this.state === "running",
        complete: snapshot.windowEndMs - snapshot.windowStartMs >= request.windowMs,
        finalFlush: request.finalFlush,
        qualityOk: assessGates(snapshot).mustSayReason === null,
        stageId: stage.stageId ?? framework.document.stages?.[0]?.id ?? null,
        stageLabel: stage.stageLabel,
        windowStartMs: snapshot.windowStartMs,
        windowEndMs: snapshot.windowEndMs,
        coverage: this.coverageView(),
        segments: this.getTranscript().finals,
        avoidHit: output.avoidHit,
      });
      for (const candidate of output.candidates) {
        const result = this.issues.upsert(candidate, snapshot.windowEndMs, framework.revision);
        if (result.recurrence && this.shouldRemindRecurrence(result.recurrence, ruleConfig.profile)) {
          this.pendingRecurrences.push(result.recurrence);
        }
        this.journal?.append("issue_upserted", { issue: result.issue });
      }
      const durationMs = Math.round(performance.now() - started);
      if (output.candidates.length === 0 && output.suppressions.length > 0) {
        this.qualityStreak += 1;
        if (this.qualityStreak >= QUALITY_GATES.qualityWarningWindows) this.qualityWarning = "音频或识别质量不足";
      } else {
        this.qualityStreak = 0;
        this.qualityWarning = null;
      }
      for (const item of output.suppressions) {
        logEvent("info", "analysis", "suppressed", { sessionId: this.sessionId, ruleId: item.ruleId, reason: item.reason });
      }
      this.lastAnalysis = {
        atMs: snapshot.windowEndMs,
        windowStartMs: snapshot.windowStartMs,
        windowEndMs: snapshot.windowEndMs,
        finalFlush: request.finalFlush,
        durationMs,
        audioCoverageMs: snapshot.audioCoverageMs,
        finalTextCoverageMs: snapshot.finalTextCoverageMs,
      };
      this.journal?.append("analysis_completed", {
        atMs: snapshot.windowEndMs,
        windowStartMs: snapshot.windowStartMs,
        windowEndMs: snapshot.windowEndMs,
        finalFlush: request.finalFlush,
        durationMs,
        audioCoverageMs: snapshot.audioCoverageMs,
        finalTextCoverageMs: snapshot.finalTextCoverageMs,
        candidates: output.candidates.length,
        suppressions: output.suppressions.length,
      });
      logEvent("info", "analysis", "completed", {
        sessionId: this.sessionId,
        delayMs: Math.max(0, request.endMs - request.scheduledAtMs),
        audioCoverageMs: snapshot.audioCoverageMs,
        finalTextCoverageMs: snapshot.finalTextCoverageMs,
        durationMs,
        finalFlush: request.finalFlush,
        candidates: output.candidates.length,
        suppressions: output.suppressions.length,
      });
      if (durationMs > QUALITY_GATES.analysisTimeoutMs) {
        logEvent("warn", "analysis", "analysis_timeout", { sessionId: this.sessionId, durationMs });
      }
      this.emitAnalysis();
      this.emitStage();
      if (this.state === "running") this.emitState();
    } catch (error) {
      this.actions.invalidate("分析失败，提醒已失效");
      logEvent("error", "analysis", "failed", {
        sessionId: this.sessionId,
        message: error instanceof Error ? error.message : "分析失败",
      });
    }
  }

  private shouldRemindRecurrence(recurrence: IssueRecurrence, profile: IssueRuleProfile): boolean {
    const interval = profile.repeatReminderIntervalMs;
    if (interval <= 0) return true;
    const last = this.lastRecurrenceReminderAt.get(recurrence.fingerprint);
    if (last !== undefined && recurrence.seenAtMs - last < interval) return false;
    this.lastRecurrenceReminderAt.set(recurrence.fingerprint, recurrence.seenAtMs);
    return true;
  }

  private coverageView(): CoverageItem[] {
    const document = this.frameworkSnapshot?.document;
    if (!document) return [];
    const byId = new Map(this.ruleState.coverage.map((item) => [item.frameworkItemId, item]));
    return document.must_say.map((item) => {
      const state = byId.get(item.id);
      return {
        frameworkItemId: item.id,
        text: item.text,
        covered: state?.covered ?? false,
        firstCoveredAtMs: state?.firstCoveredAtMs,
        matchedSegmentIds: state ? [...state.matchedSegmentIds] : [],
      };
    });
  }

  private replacedScheduler(): WindowScheduler {
    const scheduler = new WindowScheduler({
      getWindowMs: () => analysisTiming().windowMs,
      getIntervalMs: () => analysisTiming().intervalMs,
      onAnalyze: (request) => this.runAnalysis(request),
      onOverrun: (audioClockMs) => {
        logEvent("warn", "analysis", "analysis_overrun", { sessionId: this.sessionId, audioClockMs });
      },
    });
    return scheduler;
  }

  private emitAnalysis(): void {
    if (!this.sessionId) return;
    const issues = this.issues.list();
    const unreadCount = this.issues.unreadCount();
    const recurrences = this.pendingRecurrences.splice(0, this.pendingRecurrences.length);
    const issueEvent: IssuesUpdatedEvent = {
      sessionId: this.sessionId,
      issues,
      unreadCount,
      qualityWarning: this.qualityWarning,
      lastAnalysis: this.lastAnalysis ? { ...this.lastAnalysis } : null,
      recurrences,
      issueRuleProfileName: this.currentIssueRuleProfileName(),
    };
    const coverageEvent: CoverageUpdatedEvent = { sessionId: this.sessionId, items: this.coverageView() };
    for (const listener of this.issueListeners) listener(issueEvent);
    for (const listener of this.coverageListeners) listener(coverageEvent);
  }

  private emitState(): void {
    if (this.state !== "running") this.actions.invalidate("会话已暂停或停止");
    const snapshot = this.snapshot();
    for (const listener of this.stateListeners) listener(snapshot);
  }

  private emitStage(): void {
    const view = this.stageView();
    for (const listener of this.stageListeners) listener(view);
  }

  private projectionInput(): ProjectionInput {
    return {
      session: this.snapshot(),
      issues: this.issues.list(),
      stages: this.frameworkSnapshot?.document.stages,
      actionSignals: this.actions.snapshot().signals,
    };
  }

  private emitTranscript(delta: TranscriptDelta): void {
    for (const listener of this.transcriptListeners) listener(delta);
  }

  private emitPresentation(overlay: CaptionPresentation["overlay"], paused: boolean): void {
    if (!this.sessionId) return;
    if (paused && !this.punctuationPauseLogged) {
      this.punctuationPauseLogged = true;
      logEvent("warn", "transcript", "punctuation_paused", { sessionId: this.sessionId });
    }
    if (!paused) this.punctuationPauseLogged = false;
    const event: CaptionPresentation = { sessionId: this.sessionId, overlay, paused };
    for (const listener of this.presentationListeners) listener(event);
  }

  private displayPunctuator(): DisplayPunctuator | null {
    if (this.asrId !== "funasr" || !this.asr) return null;
    const candidate = this.asr as AsrAdapter & Partial<DisplayPunctuator>;
    if (typeof candidate.punctuate !== "function") return null;
    return candidate as DisplayPunctuator;
  }

  private emitLevel(frame: AudioFrame): void {
    if (!this.sessionId) return;
    const now = Date.now();
    if (now - this.lastLevelAt < 100 && frame.seq % 5 !== 0) return;
    this.lastLevelAt = now;
    const level: AudioLevelEvent = {
      sessionId: this.sessionId,
      rms: frame.rms,
      audioClockMs: frame.startMs + frame.durationMs,
      speech: (frame.speechProbability ?? 0) >= 0.5,
    };
    for (const listener of this.levelListeners) listener(level);
  }
}

function hotwordsOf(document: FrameworkDocument): string[] {
  const words = [...document.must_say, ...document.avoid].flatMap((item) => item.keywords.map((keyword) => keyword.trim()));
  return [...new Set(words)].slice(0, 80);
}

function mergeHotwords(base: readonly string[], extra: readonly string[]): string[] {
  return [...new Set([...base, ...extra.map((word) => word.trim()).filter(Boolean)])].slice(0, 80);
}

function activeNameOf(state: IssueRuleProfilesState): string | null {
  return state.profiles.find((profile) => profile.id === state.activeProfileId)?.name ?? null;
}
