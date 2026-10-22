import type { AsrHealth, AsrId } from "./asr";
import type { ActionConfig, ActionConfigState, ActionResolveRequest, ActionResult, ActionsSnapshot } from "./actions";
import type { DeviceListResult, PcmChunkPayload } from "./audio";
import type { DisplayInfo, StageOpenRequest, StagePreferences } from "./display";
import type { FrameworkLoadResult } from "./framework";
import type { AnalysisSnapshot, CoverageUpdatedEvent, IssuesUpdatedEvent, MarkReadRequest } from "./issue";
import type { IssueRuleActionResult, IssueRuleProfileInput, IssueRuleProfilesState } from "./issueRules";
import type { AudioLevelEvent, BeginCaptureEvent, SettingsSnapshot, SettingsUpdateResult, StageSetRequest } from "./ipc";
import type { SecretStatus } from "./secrets";
import type { SessionCatalogResult, SessionRenameRequest, SessionRenameResult, SessionReplayResult } from "./replay";
import type { SessionSnapshot, SessionStartOptions } from "./session";
import type { StageTranscriptPayload, StageView } from "./stage";
import type { CaptionPresentation, TranscriptDelta, TranscriptView } from "./transcript";

/**
 * preload 通过 contextBridge 暴露的全部能力。没有通用 invoke/send。
 * Stage 只读：只暴露 getStageState / onStagePush，不暴露任何写通道。
 */
export type DingboBridge = {
  getActionConfig: () => Promise<ActionConfigState>;
  saveActionConfig: (config: ActionConfig) => Promise<ActionResult>;
  getActions: () => Promise<ActionsSnapshot>;
  resolveAction: (request: ActionResolveRequest) => Promise<ActionResult>;
  onActions: (listener: (snapshot: ActionsSnapshot) => void) => () => void;
  listDevices: () => Promise<DeviceListResult>;
  getSettings: () => Promise<SettingsSnapshot>;
  updateSettings: (patch: unknown) => Promise<SettingsUpdateResult>;
  getSecretStatus: () => Promise<SecretStatus>;
  setCloudAsrKey: (key: string) => Promise<SecretStatus>;
  clearCloudAsrKey: () => Promise<SecretStatus>;
  getXfyunSecretStatus: () => Promise<SecretStatus>;
  setXfyunCredentials: (credentials: { appId: string; apiKey: string }) => Promise<SecretStatus>;
  clearXfyunCredentials: () => Promise<SecretStatus>;
  checkAsr: (id: AsrId) => Promise<AsrHealth>;
  loadFramework: () => Promise<FrameworkLoadResult>;
  selectFramework: () => Promise<FrameworkLoadResult>;
  getAnalysis: () => Promise<AnalysisSnapshot>;
  markIssueRead: (request: MarkReadRequest) => Promise<AnalysisSnapshot>;
  getIssueRuleProfiles: () => Promise<IssueRuleProfilesState>;
  saveIssueRuleProfile: (profile: IssueRuleProfileInput) => Promise<IssueRuleActionResult>;
  deleteIssueRuleProfile: (id: string) => Promise<IssueRuleActionResult>;
  activateIssueRuleProfile: (id: string) => Promise<IssueRuleActionResult>;
  startSession: (options: SessionStartOptions) => Promise<SessionSnapshot>;
  stopSession: () => Promise<SessionSnapshot>;
  /** Control 专用：读取/切换直播流播放窗是否显示，用于扫码登录。默认隐藏，只抽音。 */
  getStreamWindowVisible: () => Promise<{ visible: boolean }>;
  setStreamWindowVisible: (visible: boolean) => Promise<{ ok: boolean; visible: boolean }>;
  /** Control 专用：macOS 首帧超时，直播窗保持隐藏，主界面提示。 */
  onStreamCaptureStalled: (listener: (payload: { message: string }) => void) => () => void;
  /** Control 专用：用户点了直播窗关闭按钮，画面已回到隐藏采集。 */
  onStreamWindowVisibility: (listener: (payload: { visible: boolean }) => void) => () => void;
  getSession: () => Promise<SessionSnapshot>;
  getTranscript: () => Promise<TranscriptView>;
  loadCurrentReplay: () => Promise<SessionReplayResult>;
  listReplaySessions: () => Promise<SessionCatalogResult>;
  loadReplayBySessionId: (sessionId: string) => Promise<SessionReplayResult>;
  renameReplaySession: (request: SessionRenameRequest) => Promise<SessionRenameResult>;
  pushAudioChunk: (chunk: PcmChunkPayload) => void;
  notifyCaptureFailed: (sessionId: string, message: string) => void;
  onSessionState: (listener: (snapshot: SessionSnapshot) => void) => () => void;
  onTranscript: (listener: (delta: TranscriptDelta) => void) => () => void;
  onPresentation: (listener: (event: CaptionPresentation) => void) => () => void;
  onLevel: (listener: (level: AudioLevelEvent) => void) => () => void;
  onBeginCapture: (listener: (event: BeginCaptureEvent) => void) => () => void;
  onIssues: (listener: (event: IssuesUpdatedEvent) => void) => () => void;
  onCoverage: (listener: (event: CoverageUpdatedEvent) => void) => () => void;
  /** Control 专用：打开 Stage 窗口。 */
  openStage: (request: StageOpenRequest) => Promise<{ ok: boolean; message?: string }>;
  /** Control 专用：关闭 Stage 窗口。 */
  closeStage: () => Promise<void>;
  /** Control 专用：更新阶段 / pin / dismiss / 品备注。 */
  setStage: (request: StageSetRequest) => Promise<{ ok: boolean; message?: string }>;
  /** Control 专用：拉取显示器列表。 */
  listStageDisplays: () => Promise<DisplayInfo[]>;
  /** Control 专用：读取/保存抬头屏显示偏好。 */
  getStagePreferences: () => Promise<StagePreferences>;
  saveStagePreferences: (preferences: StagePreferences) => Promise<StagePreferences>;
  /** Control 专用：抬头屏事件。 */
  onStageLoadFailed: (listener: (payload: { message: string }) => void) => () => void;
  onStageDisplayDisconnected: (listener: (payload: { displayLabel: string | null }) => void) => () => void;
  /** Stage 专用：拉取当前 StageView。 */
  getStageState: () => Promise<StageView>;
  /** Stage 专用：订阅 StageView 推送。 */
  onStagePush: (listener: (view: StageView) => void) => () => void;
  /** Stage 专用：拉取当前字幕快照。 */
  getStageTranscript: () => Promise<StageTranscriptPayload>;
  /** Stage 专用：订阅字幕推送。 */
  onStageTranscript: (listener: (payload: StageTranscriptPayload) => void) => () => void;
};
