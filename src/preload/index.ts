import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DingboBridge } from "@shared/contracts/bridge";
import type { ActionsSnapshot } from "@shared/contracts/actions";
import { IpcChannels } from "@shared/contracts/ipc";
import type { CoverageUpdatedEvent, IssuesUpdatedEvent } from "@shared/contracts/issue";
import type { AudioLevelEvent, BeginCaptureEvent } from "@shared/contracts/ipc";
import type { SessionSnapshot } from "@shared/contracts/session";
import type { StageTranscriptPayload, StageView } from "@shared/contracts/stage";
import type { CaptionPresentation, TranscriptDelta } from "@shared/contracts/transcript";
import { installStreamTap } from "./streamTap";

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: DingboBridge = {
  getActionConfig: () => ipcRenderer.invoke(IpcChannels.actionsGetConfig),
  saveActionConfig: (config) => ipcRenderer.invoke(IpcChannels.actionsSaveConfig, config),
  getActions: () => ipcRenderer.invoke(IpcChannels.actionsGet),
  resolveAction: (request) => ipcRenderer.invoke(IpcChannels.actionsResolve, request),
  onActions: (listener) => subscribe<ActionsSnapshot>(IpcChannels.actionsChanged, listener),
  listDevices: () => ipcRenderer.invoke(IpcChannels.listDevices),
  getSettings: () => ipcRenderer.invoke(IpcChannels.settingsGet),
  updateSettings: (patch) => ipcRenderer.invoke(IpcChannels.settingsUpdate, patch),
  getSecretStatus: () => ipcRenderer.invoke(IpcChannels.secretsStatus),
  setCloudAsrKey: (key) => ipcRenderer.invoke(IpcChannels.secretsSet, { key }),
  clearCloudAsrKey: () => ipcRenderer.invoke(IpcChannels.secretsClear),
  getXfyunSecretStatus: () => ipcRenderer.invoke(IpcChannels.xfyunSecretsStatus),
  setXfyunCredentials: (credentials) => ipcRenderer.invoke(IpcChannels.xfyunSecretsSet, credentials),
  clearXfyunCredentials: () => ipcRenderer.invoke(IpcChannels.xfyunSecretsClear),
  checkAsr: (id) => ipcRenderer.invoke(IpcChannels.asrHealth, id),
  loadFramework: () => ipcRenderer.invoke(IpcChannels.frameworkLoad),
  selectFramework: () => ipcRenderer.invoke(IpcChannels.frameworkSelect),
  getAnalysis: () => ipcRenderer.invoke(IpcChannels.analysisGet),
  markIssueRead: (request) => ipcRenderer.invoke(IpcChannels.issueMarkRead, request),
  getIssueRuleProfiles: () => ipcRenderer.invoke(IpcChannels.issueRulesGet),
  saveIssueRuleProfile: (profile) => ipcRenderer.invoke(IpcChannels.issueRulesSave, profile),
  deleteIssueRuleProfile: (id) => ipcRenderer.invoke(IpcChannels.issueRulesDelete, id),
  activateIssueRuleProfile: (id) => ipcRenderer.invoke(IpcChannels.issueRulesActivate, id),
  startSession: (options) => ipcRenderer.invoke(IpcChannels.sessionStart, options),
  stopSession: () => ipcRenderer.invoke(IpcChannels.sessionStop),
  getStreamWindowVisible: () => ipcRenderer.invoke(IpcChannels.streamWindowGet),
  setStreamWindowVisible: (visible) => ipcRenderer.invoke(IpcChannels.streamWindowSet, { visible }),
  onStreamCaptureStalled: (listener) => subscribe<{ message: string }>(IpcChannels.streamCaptureStalled, listener),
  onStreamWindowVisibility: (listener) => subscribe<{ visible: boolean }>(IpcChannels.streamWindowVisibility, listener),
  getSession: () => ipcRenderer.invoke(IpcChannels.sessionGet),
  getTranscript: () => ipcRenderer.invoke(IpcChannels.transcriptGet),
  loadCurrentReplay: () => ipcRenderer.invoke(IpcChannels.replayLoadCurrent),
  listReplaySessions: () => ipcRenderer.invoke(IpcChannels.replayListSessions),
  loadReplayBySessionId: (sessionId) => ipcRenderer.invoke(IpcChannels.replayLoadBySessionId, sessionId),
  renameReplaySession: (request) => ipcRenderer.invoke(IpcChannels.replayRenameSession, request),
  pushAudioChunk: (chunk) => ipcRenderer.send(IpcChannels.chunk, chunk),
  notifyCaptureFailed: (sessionId, message) => {
    ipcRenderer.send(IpcChannels.captureFailed, { sessionId, message });
  },
  onSessionState: (listener) => subscribe<SessionSnapshot>(IpcChannels.sessionState, listener),
  onTranscript: (listener) => subscribe<TranscriptDelta>(IpcChannels.transcriptDelta, listener),
  onPresentation: (listener) => subscribe<CaptionPresentation>(IpcChannels.transcriptPresentation, listener),
  onLevel: (listener) => subscribe<AudioLevelEvent>(IpcChannels.level, listener),
  onBeginCapture: (listener) => subscribe<BeginCaptureEvent>(IpcChannels.beginCapture, listener),
  onIssues: (listener) => subscribe<IssuesUpdatedEvent>(IpcChannels.issuesUpdated, listener),
  onCoverage: (listener) => subscribe<CoverageUpdatedEvent>(IpcChannels.coverageUpdated, listener),
  openStage: (request) => ipcRenderer.invoke(IpcChannels.stageOpen, request),
  closeStage: () => ipcRenderer.invoke(IpcChannels.stageClose),
  setStage: (request) => ipcRenderer.invoke(IpcChannels.stageSet, request),
  listStageDisplays: () => ipcRenderer.invoke(IpcChannels.stageDisplayList),
  getStagePreferences: () => ipcRenderer.invoke(IpcChannels.stagePreferencesGet),
  saveStagePreferences: (preferences) => ipcRenderer.invoke(IpcChannels.stagePreferencesSet, preferences),
  onStageLoadFailed: (listener) => subscribe<{ message: string }>(IpcChannels.stageLoadFailed, listener),
  onStageDisplayDisconnected: (listener) =>
    subscribe<{ displayLabel: string | null }>(IpcChannels.stageDisplayDisconnected, listener),
  getStageState: () => ipcRenderer.invoke(IpcChannels.stageGetState),
  onStagePush: (listener) => subscribe<StageView>(IpcChannels.stagePush, listener),
  getStageTranscript: () => ipcRenderer.invoke(IpcChannels.stageGetTranscript),
  onStageTranscript: (listener) => subscribe<StageTranscriptPayload>(IpcChannels.stageTranscript, listener),
};

const stageApi = {
  getStageState: api.getStageState,
  getStageTranscript: api.getStageTranscript,
  onStagePush: api.onStagePush,
  onStageTranscript: api.onStageTranscript,
};

if (process.argv.includes("--dingbo-surface=stream")) {
  // 直播流播放窗：只装音频旁路，不向远程页面暴露任何 bridge。
  const sessionArg = process.argv.find((arg) => arg.startsWith("--dingbo-stream-session="));
  const sessionId = sessionArg ? sessionArg.slice("--dingbo-stream-session=".length) : "";
  if (sessionId) {
    installStreamTap({
      sessionId,
      send: (chunk) => ipcRenderer.send(IpcChannels.streamChunk, chunk),
      onError: (message) => ipcRenderer.send(IpcChannels.streamFailed, { sessionId, message }),
    });
  }
} else {
  contextBridge.exposeInMainWorld("dingbo", process.argv.includes("--dingbo-surface=stage") ? stageApi : api);
}
