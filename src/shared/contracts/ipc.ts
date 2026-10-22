import type { ActionConfig, ActionConfigState, ActionResolveRequest, ActionResult, ActionsSnapshot } from "./actions";
import type { AsrHealth, AsrId } from "./asr";
import type { DeviceListResult } from "./audio";
import type { DisplayInfo, StageOpenRequest, StagePreferences } from "./display";
import type { FrameworkLoadResult } from "./framework";
import type { AnalysisSnapshot, CoverageUpdatedEvent, IssuesUpdatedEvent, MarkReadRequest } from "./issue";
import type { IssueRuleActionResult, IssueRuleProfileInput, IssueRuleProfilesState } from "./issueRules";
import type { SecretStatus } from "./secrets";
import type { SessionCatalogResult, SessionRenameRequest, SessionRenameResult, SessionReplayResult } from "./replay";
import type { SessionSnapshot, SessionStartOptions } from "./session";
import type { StageTranscriptPayload, StageView } from "./stage";
import type { CaptionPresentation, TranscriptDelta, TranscriptView } from "./transcript";

export const IpcChannels = {
  actionsGetConfig: "actions:get-config",
  actionsSaveConfig: "actions:save-config",
  actionsGet: "actions:get",
  actionsChanged: "actions:changed",
  actionsResolve: "actions:resolve",
  listDevices: "audio:listDevices",
  chunk: "audio:chunk",
  captureFailed: "audio:captureFailed",
  beginCapture: "audio:beginCapture",
  level: "audio:level",
  streamChunk: "audio:streamChunk",
  streamFailed: "audio:streamFailed",
  streamWindowGet: "stream:window-get",
  streamWindowSet: "stream:window-set",
  streamWindowVisibility: "stream:window-visibility",
  streamCaptureStalled: "stream:capture-stalled",
  sessionStart: "session:start",
  sessionStop: "session:stop",
  sessionGet: "session:get",
  sessionState: "session:stateChanged",
  transcriptGet: "transcript:get",
  transcriptDelta: "transcript:delta",
  transcriptPresentation: "transcript:presentation",
  replayLoadCurrent: "replay:loadCurrent",
  replayListSessions: "replay:listSessions",
  replayLoadBySessionId: "replay:loadBySessionId",
  replayRenameSession: "replay:renameSession",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  asrHealth: "asr:checkHealth",
  frameworkLoad: "framework:load",
  frameworkSelect: "framework:select",
  analysisGet: "analysis:get",
  issuesUpdated: "analysis:issuesUpdated",
  coverageUpdated: "analysis:coverageUpdated",
  issueMarkRead: "issue:markRead",
  issueRulesGet: "issue-rules:get",
  issueRulesSave: "issue-rules:save",
  issueRulesDelete: "issue-rules:delete",
  issueRulesActivate: "issue-rules:activate",
  secretsStatus: "secrets:status",
  secretsSet: "secrets:set",
  secretsClear: "secrets:clear",
  xfyunSecretsStatus: "secrets:xfyun:status",
  xfyunSecretsSet: "secrets:xfyun:set",
  xfyunSecretsClear: "secrets:xfyun:clear",
  stageOpen: "stage:open",
  stageClose: "stage:close",
  stagePush: "stage:push",
  stageGetState: "stage:get-state",
  stageDisplayList: "stage:display-list",
  stageSet: "stage:set",
  stageTranscript: "stage:transcript",
  stageGetTranscript: "stage:get-transcript",
  stageLoadFailed: "stage:load-failed",
  stageDisplayDisconnected: "stage:display-disconnected",
  stagePreferencesGet: "stage:preferences-get",
  stagePreferencesSet: "stage:preferences-set",
} as const;

export type AudioLevelEvent = {
  sessionId: string;
  rms: number;
  audioClockMs: number;
  speech: boolean;
};

export type BeginCaptureEvent = {
  sessionId: string;
};

export type CaptureFailedPayload = {
  sessionId: string;
  message: string;
};

export type SettingsSnapshot = {
  windowMs: number;
  intervalMs: number;
  windowMsRange: readonly [number, number];
  intervalMsRange: readonly [number, number];
  windowEditable: boolean;
  intervalEditable: boolean;
  persisted: boolean;
  note: string;
  /** 直播流是否从本机扬声器外放。默认 false。与是否显示直播画面无关。 */
  streamAudible: boolean;
  asrOptions: Array<{ id: AsrId; label: string; detail: string }>;
  reconnect: {
    backoffMs: readonly number[];
    maxAttempts: number;
    autoReconnect: boolean;
  };
};

export type SettingsUpdateResult = {
  ok: boolean;
  code?: "invalid" | "session_active" | "persist_failed";
  message: string;
  settings: SettingsSnapshot;
};

export type StageSetRequest =
  | { stageId: string }
  | { pinIssueId: string }
  | { dismissIssueId: string }
  | { clearPin: true }
  | { productNote: string | null };

export type IpcPushMap = {
  [IpcChannels.sessionState]: SessionSnapshot;
  [IpcChannels.transcriptDelta]: TranscriptDelta;
  [IpcChannels.transcriptPresentation]: CaptionPresentation;
  [IpcChannels.level]: AudioLevelEvent;
  [IpcChannels.beginCapture]: BeginCaptureEvent;
  [IpcChannels.issuesUpdated]: IssuesUpdatedEvent;
  [IpcChannels.coverageUpdated]: CoverageUpdatedEvent;
  [IpcChannels.stagePush]: StageView;
  [IpcChannels.stageTranscript]: StageTranscriptPayload;
  [IpcChannels.actionsChanged]: ActionsSnapshot;
  [IpcChannels.stageLoadFailed]: { message: string };
  [IpcChannels.stageDisplayDisconnected]: { displayLabel: string | null };
  [IpcChannels.streamCaptureStalled]: { message: string };
  [IpcChannels.streamWindowVisibility]: { visible: boolean };
};

export type IpcInvokeMap = {
  [IpcChannels.actionsGetConfig]: { args: void; result: ActionConfigState };
  [IpcChannels.actionsSaveConfig]: { args: ActionConfig; result: ActionResult };
  [IpcChannels.actionsGet]: { args: void; result: ActionsSnapshot };
  [IpcChannels.actionsResolve]: { args: ActionResolveRequest; result: ActionResult };
  [IpcChannels.listDevices]: { args: void; result: DeviceListResult };
  [IpcChannels.sessionStart]: { args: SessionStartOptions; result: SessionSnapshot };
  [IpcChannels.sessionStop]: { args: void; result: SessionSnapshot };
  [IpcChannels.sessionGet]: { args: void; result: SessionSnapshot };
  [IpcChannels.transcriptGet]: { args: void; result: TranscriptView };
  [IpcChannels.replayLoadCurrent]: { args: void; result: SessionReplayResult };
  [IpcChannels.replayListSessions]: { args: void; result: SessionCatalogResult };
  [IpcChannels.replayLoadBySessionId]: { args: string; result: SessionReplayResult };
  [IpcChannels.replayRenameSession]: { args: SessionRenameRequest; result: SessionRenameResult };
  [IpcChannels.settingsGet]: { args: void; result: SettingsSnapshot };
  [IpcChannels.settingsUpdate]: { args: unknown; result: SettingsUpdateResult };
  [IpcChannels.asrHealth]: { args: AsrId; result: AsrHealth };
  [IpcChannels.frameworkLoad]: { args: void; result: FrameworkLoadResult };
  [IpcChannels.frameworkSelect]: { args: void; result: FrameworkLoadResult };
  [IpcChannels.analysisGet]: { args: void; result: AnalysisSnapshot };
  [IpcChannels.issueMarkRead]: { args: MarkReadRequest; result: AnalysisSnapshot };
  [IpcChannels.issueRulesGet]: { args: void; result: IssueRuleProfilesState };
  [IpcChannels.issueRulesSave]: { args: IssueRuleProfileInput; result: IssueRuleActionResult };
  [IpcChannels.issueRulesDelete]: { args: string; result: IssueRuleActionResult };
  [IpcChannels.issueRulesActivate]: { args: string; result: IssueRuleActionResult };
  [IpcChannels.secretsStatus]: { args: void; result: SecretStatus };
  [IpcChannels.secretsSet]: { args: unknown; result: SecretStatus };
  [IpcChannels.secretsClear]: { args: void; result: SecretStatus };
  [IpcChannels.xfyunSecretsStatus]: { args: void; result: SecretStatus };
  [IpcChannels.xfyunSecretsSet]: { args: unknown; result: SecretStatus };
  [IpcChannels.xfyunSecretsClear]: { args: void; result: SecretStatus };
  [IpcChannels.stageOpen]: { args: StageOpenRequest; result: { ok: boolean; message?: string } };
  [IpcChannels.stageClose]: { args: void; result: void };
  [IpcChannels.stageGetState]: { args: void; result: StageView };
  [IpcChannels.stageDisplayList]: { args: void; result: DisplayInfo[] };
  [IpcChannels.stageSet]: { args: StageSetRequest; result: { ok: boolean; message?: string } };
  [IpcChannels.stageGetTranscript]: { args: void; result: StageTranscriptPayload };
  [IpcChannels.stagePreferencesGet]: { args: void; result: StagePreferences };
  [IpcChannels.stagePreferencesSet]: { args: StagePreferences; result: StagePreferences };
  [IpcChannels.streamWindowGet]: { args: void; result: { visible: boolean } };
  [IpcChannels.streamWindowSet]: { args: { visible: boolean }; result: { ok: boolean; visible: boolean } };
};
