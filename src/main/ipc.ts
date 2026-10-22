import { randomUUID } from "node:crypto";
import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { controlContents, isWindowSender } from "./ipc/roles";
import { resolveActionSchema } from "./actions/schema";
import { IpcChannels } from "@shared/contracts/ipc";
import { rejectionForAsrStart } from "@shared/session/credentialGate";
import { summarizeDiagnostic } from "@shared/text/diagnostics";
import type { AsrHealth, AsrId } from "@shared/contracts/asr";
import type { SessionState } from "@shared/contracts/session";
import type { SessionController } from "./session/SessionController";
import { AsrAdapterManager } from "./asr/AsrAdapterManager";
import { listAudioDevices } from "./devices";
import { FrameworkStore } from "./framework/FrameworkStore";
import { parseAsrId, parseAudioChunk, parseCaptureFailed, parseMarkRead, parseReplaySessionId, parseSecretSet, parseSessionRename, parseSessionStart, parseSettingsUpdate, parseStageOpen, parseStageSet, parseXfyunSecretSet, stagePreferencesSchema } from "./ipc/schemas";
import { logEvent } from "./security/log";
import type { SecretStore } from "./security/SecretStore";
import { applySettingsUpdate, currentSettings, rejectSettingsUpdate } from "./settings";
import { listDisplays } from "./stage/displays";
import type { StagePreferencesStore } from "./stage/preferences";
import { StageWindowManager } from "./stage/StageWindowManager";
import type { StreamWindowManager } from "./audio/streamWindow";

export type IpcRuntime = {
  getWindow: () => BrowserWindow | null;
  controller: SessionController;
  asr: AsrAdapterManager;
  frameworks: FrameworkStore;
  secrets: SecretStore;
  stageManager: StageWindowManager;
  stagePreferences: StagePreferencesStore;
  streamWindows: StreamWindowManager;
};

export type AsrHealthChecker = {
  check(id: AsrId): Promise<AsrHealth>;
  pendingCount(id: AsrId): number;
};

export function createAsrHealthChecker(
  createAdapter: (id: AsrId) => { checkHealth(): Promise<AsrHealth>; stop(): Promise<void> },
  isSessionBusy: () => boolean,
  ids: () => { checkId: string; checkedAt: string } = () => ({ checkId: randomUUID(), checkedAt: new Date().toISOString() }),
): AsrHealthChecker {
  const healthChecks = new Map<AsrId, Promise<AsrHealth>>();
  const check = (id: AsrId): Promise<AsrHealth> => {
    const pending = healthChecks.get(id);
    if (pending) return pending;
    const { checkId, checkedAt } = ids();
    const promise = (async (): Promise<AsrHealth> => {
      if (isSessionBusy()) {
        return { ok: false, detail: "盯播进行中不能重新预检识别服务。", checkId, checkedAt };
      }
      const adapter = createAdapter(id);
      try {
        const health = await adapter.checkHealth();
        return {
          ...health,
          detail: health.detail === undefined ? undefined : summarizeDiagnostic(health.detail),
          checkId,
          checkedAt,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : "识别服务健康预检失败。";
        logEvent("warn", "asr", "health_failed", { asrId: id, detail });
        return {
          ok: false,
          detail: summarizeDiagnostic(detail) || "识别服务健康预检失败。",
          checkId,
          checkedAt,
        };
      } finally {
        await adapter.stop();
      }
    })().finally(() => {
      if (healthChecks.get(id) === promise) healthChecks.delete(id);
    });
    healthChecks.set(id, promise);
    return promise;
  };
  return { check, pendingCount: (id) => healthChecks.has(id) ? 1 : 0 };
}

export function registerIpc(runtime: IpcRuntime): void {
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      const control = isWindowSender(event, controlContents(runtime.getWindow()));
      const stageRead = channel === IpcChannels.stageGetState || channel === IpcChannels.stageGetTranscript;
      if (!control && !(stageRead && isWindowSender(event, runtime.stageManager.contents()))) {
        throw new Error("当前窗口无权调用该操作。");
      }
      return listener(event, ...args);
    });
  };
  const healthChecker = createAsrHealthChecker(
    (id) => runtime.asr.create(id),
    () => sessionBusy(runtime.controller.snapshot().state),
  );
  const checkHealth = (id: AsrId) => healthChecker.check(id);

  const send = (channel: string, payload: unknown) => {
    const window = runtime.getWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(channel, payload);
  };

  runtime.controller.onState((snapshot) => send(IpcChannels.sessionState, snapshot));
  runtime.controller.onTranscript((delta) => {
    send(IpcChannels.transcriptDelta, delta);
    // 字幕增量到达后，把最新快照推给 Stage，避免增量丢帧。
    runtime.stageManager.pushTranscript(runtime.controller.getTranscript());
  });
  runtime.controller.onPresentation((event) => {
    send(IpcChannels.transcriptPresentation, event);
    runtime.stageManager.pushTranscript(runtime.controller.getTranscript());
  });
  runtime.controller.onLevel((level) => send(IpcChannels.level, level));
  runtime.controller.onIssues((event) => send(IpcChannels.issuesUpdated, event));
  runtime.controller.onCoverage((event) => send(IpcChannels.coverageUpdated, event));
  runtime.controller.onStage((view) => runtime.stageManager.push(view));
  runtime.controller.actions.onChange(() => send(IpcChannels.actionsChanged, runtime.controller.actionSnapshot()));

  handle(IpcChannels.actionsGetConfig, () => runtime.controller.actions.getConfig(runtime.frameworks.current()));
  handle(IpcChannels.actionsSaveConfig, (_event, raw: unknown) => runtime.controller.saveActionConfig(raw));
  handle(IpcChannels.actionsGet, () => runtime.controller.actionSnapshot());
  handle(IpcChannels.actionsResolve, (_event, raw: unknown) => {
    const parsed = resolveActionSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, message: "动作处理参数不合法。" };
    return runtime.controller.resolveAction(parsed.data);
  });

  handle(IpcChannels.listDevices, () => listAudioDevices());
  handle(IpcChannels.settingsGet, () => currentSettings());
  handle(IpcChannels.settingsUpdate, (_event, raw: unknown) => {
    const parsed = parseSettingsUpdate(raw);
    if (!parsed) return rejectSettingsUpdate("invalid", "设置参数不合法。只接受窗口、间隔和直播流外放。");
    if ("windowMs" in parsed && sessionBusy(runtime.controller.snapshot().state)) {
      return rejectSettingsUpdate("session_active", "盯播进行中不能修改窗口和间隔。");
    }
    const result = applySettingsUpdate(raw);
    if (result.ok) runtime.streamWindows.setAudible(result.settings.streamAudible);
    return result;
  });
  handle(IpcChannels.secretsStatus, () => runtime.secrets.status());
  handle(IpcChannels.secretsSet, async (_event, raw: unknown) => {
    if (sessionBusy(runtime.controller.snapshot().state)) {
      const status = await runtime.secrets.status();
      return { ...status, message: "盯播进行中不能更换密钥。" };
    }
    const parsed = parseSecretSet(raw);
    if (!parsed) {
      const status = await runtime.secrets.status();
      return { ...status, message: "密钥格式不正确。" };
    }
    return runtime.secrets.setCloudAsrKey(parsed.key);
  });
  handle(IpcChannels.secretsClear, async () => {
    if (sessionBusy(runtime.controller.snapshot().state)) {
      const status = await runtime.secrets.status();
      return { ...status, message: "盯播进行中不能清除密钥。" };
    }
    return runtime.secrets.clearCloudAsrKey();
  });
  handle(IpcChannels.xfyunSecretsStatus, () => runtime.secrets.status("xfyun"));
  handle(IpcChannels.xfyunSecretsSet, async (_event, raw: unknown) => {
    if (sessionBusy(runtime.controller.snapshot().state)) {
      const status = await runtime.secrets.status("xfyun");
      return { ...status, message: "盯播进行中不能更换讯飞凭据。" };
    }
    const parsed = parseXfyunSecretSet(raw);
    if (!parsed) {
      const status = await runtime.secrets.status("xfyun");
      return { ...status, message: "讯飞凭据格式不正确。APPID 和 APIKey 都必须填写。" };
    }
    return runtime.secrets.setXfyunCredentials(parsed);
  });
  handle(IpcChannels.xfyunSecretsClear, async () => {
    if (sessionBusy(runtime.controller.snapshot().state)) {
      const status = await runtime.secrets.status("xfyun");
      return { ...status, message: "盯播进行中不能清除讯飞凭据。" };
    }
    return runtime.secrets.clearXfyunCredentials();
  });
  handle(IpcChannels.frameworkLoad, () => runtime.frameworks.current());
  handle(IpcChannels.frameworkSelect, async () => {
    if (sessionBusy(runtime.controller.snapshot().state)) {
      const current = runtime.frameworks.current();
      return {
        ok: false as const,
        code: "session_active" as const,
        message: "盯播进行中不能更换话术框架。",
        sourcePath: current.ok ? current.sourcePath ?? undefined : current.sourcePath,
      };
    }
    const parent = runtime.getWindow();
    const picked = parent
      ? await dialog.showOpenDialog(parent, {
          title: "选择话术框架 JSON",
          properties: ["openFile"],
          filters: [{ name: "JSON", extensions: ["json"] }],
        })
      : await dialog.showOpenDialog({
          title: "选择话术框架 JSON",
          properties: ["openFile"],
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
    const filePath = picked.filePaths[0];
    if (picked.canceled || !filePath) return runtime.frameworks.current();
    return runtime.frameworks.loadFile(filePath);
  });
  handle(IpcChannels.analysisGet, () => runtime.controller.analysisSnapshot());
  handle(IpcChannels.issueMarkRead, (_event, raw: unknown) => {
    const request = parseMarkRead(raw);
    if (!request) throw new Error("已读参数不合法。");
    if ("all" in request) runtime.controller.markAllIssuesRead();
    else runtime.controller.markIssueRead(request.id);
    return runtime.controller.analysisSnapshot();
  });
  handle(IpcChannels.issueRulesGet, () => runtime.controller.issueRuleProfilesState());
  handle(IpcChannels.issueRulesSave, (_event, raw: unknown) => runtime.controller.saveIssueRuleProfile(raw));
  handle(IpcChannels.issueRulesDelete, (_event, raw: unknown) => {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) {
      return { ok: false, message: "方案编号不合法。", state: runtime.controller.issueRuleProfilesState() };
    }
    return runtime.controller.deleteIssueRuleProfile(raw);
  });
  handle(IpcChannels.issueRulesActivate, (_event, raw: unknown) => {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) {
      return { ok: false, message: "方案编号不合法。", state: runtime.controller.issueRuleProfilesState() };
    }
    return runtime.controller.activateIssueRuleProfile(raw);
  });
  handle(IpcChannels.sessionGet, () => runtime.controller.snapshot());
  handle(IpcChannels.transcriptGet, () => runtime.controller.getTranscript());
  handle(IpcChannels.replayLoadCurrent, () => runtime.controller.currentReplay());
  handle(IpcChannels.replayListSessions, () => runtime.controller.listReplaySessions());
  handle(IpcChannels.replayLoadBySessionId, (_event, raw: unknown) => {
    const sessionId = parseReplaySessionId(raw);
    if (!sessionId) return { ok: false as const, code: "invalid" as const, message: "场次编号不合法，不能打开。" };
    return runtime.controller.loadReplayBySessionId(sessionId);
  });
  handle(IpcChannels.replayRenameSession, (_event, raw: unknown) => {
    const request = parseSessionRename(raw);
    if (!request) return { ok: false as const, code: "invalid" as const, message: "命名参数不合法。" };
    return runtime.controller.renameReplaySession(request.sessionId, request.title);
  });
  handle(IpcChannels.asrHealth, async (_event, raw: unknown) => {
    const id = parseAsrId(raw);
    if (!id) return { ok: false, detail: "未知的 ASR 标识" };
    return checkHealth(id);
  });
  handle(IpcChannels.sessionStart, async (_event, raw: unknown) => {
    const options = parseSessionStart(raw);
    if (!options) {
      logEvent("warn", "ipc", "rejected_start", {});
      throw new Error("开始参数不合法。音源接受 loopback/simulated/stream（stream 需要合法的抖音直播间链接），识别接受 fake/funasr/xfyun。");
    }
    const rejection = await rejectionForAsrStart(options.asrId, async () => {
      const status = await runtime.secrets.status("xfyun");
      return status.configured;
    });
    if (rejection) {
      logEvent("warn", "ipc", "rejected_start", { reason: "xfyun_credentials_missing" });
      throw new Error(rejection);
    }
    const health = await checkHealth(options.asrId);
    if (!health.ok) {
      logEvent("warn", "ipc", "rejected_start", { reason: "asr_health_failed", asrId: options.asrId });
      throw new Error(health.detail || "识别服务健康预检失败，不能开始盯播。");
    }
    return runtime.controller.start(options);
  });
  handle(IpcChannels.sessionStop, () => runtime.controller.stop().finally(() => {
    runtime.stageManager.close();
  }));

  // M5 Stage 通道
  handle(IpcChannels.stageDisplayList, () => listDisplays());
  handle(IpcChannels.stageOpen, (_event, raw: unknown) => {
    const request = parseStageOpen(raw);
    if (!request) return { ok: false, message: "打开抬头屏参数不合法。" };
    return runtime.stageManager.open(request);
  });
  handle(IpcChannels.stageClose, () => {
    runtime.stageManager.close();
  });
  handle(IpcChannels.stageGetState, () => runtime.controller.stageView());
  handle(IpcChannels.stageGetTranscript, () => {
    const view = runtime.controller.getTranscript();
    return {
      sessionId: view.sessionId,
      finals: view.finals,
      partial: view.partial,
      presentation: view.presentation ?? null,
    };
  });
  handle(IpcChannels.stagePreferencesGet, () => runtime.stagePreferences.read());
  handle(IpcChannels.stagePreferencesSet, (_event, raw: unknown) => {
    const parsed = stagePreferencesSchema.safeParse(raw);
    if (!parsed.success) return runtime.stagePreferences.read();
    return runtime.stagePreferences.write(parsed.data);
  });
  handle(IpcChannels.stageSet, (_event, raw: unknown) => {
    const request = parseStageSet(raw);
    if (!request) return { ok: false, message: "stage:set 参数不合法。" };
    if ("stageId" in request) {
      runtime.controller.setStageId(request.stageId);
      return { ok: true };
    }
    if ("pinIssueId" in request) {
      runtime.controller.pinIssue(request.pinIssueId);
      return { ok: true };
    }
    if ("dismissIssueId" in request) {
      runtime.controller.dismissIssue(request.dismissIssueId);
      return { ok: true };
    }
    if ("clearPin" in request) {
      runtime.controller.unpinIssue();
      return { ok: true };
    }
    if ("productNote" in request) {
      runtime.controller.setProductNote(request.productNote);
      return { ok: true };
    }
    return { ok: false, message: "未知的 stage:set 请求。" };
  });

  handle(IpcChannels.streamWindowGet, () => ({ visible: runtime.streamWindows.isVisible() }));
  handle(IpcChannels.streamWindowSet, (_event, raw: unknown) => {
    const value = raw && typeof raw === "object" ? (raw as { visible?: unknown }).visible : undefined;
    if (typeof value !== "boolean") return { ok: false, visible: runtime.streamWindows.isVisible() };
    // setVisible 返回的是「请求是否达成」，不是当前是否可见。隐藏成功时它为 true。
    runtime.streamWindows.setVisible(value);
    const visible = runtime.streamWindows.isVisible();
    return { ok: visible === value, visible };
  });

  ipcMain.on(IpcChannels.chunk, (_event, raw: unknown) => {
    if (!isWindowSender(_event, controlContents(runtime.getWindow()))) return;
    const chunk = parseAudioChunk(raw);
    if (!chunk) return;
    runtime.controller.ingestChunk(chunk);
  });
  ipcMain.on(IpcChannels.captureFailed, (_event, raw: unknown) => {
    if (!isWindowSender(_event, controlContents(runtime.getWindow()))) return;
    const payload = parseCaptureFailed(raw);
    if (!payload) return;
    runtime.controller.notifyCaptureFailed(payload.sessionId, payload.message);
  });
  ipcMain.on(IpcChannels.streamChunk, (_event, raw: unknown) => {
    if (!isWindowSender(_event, runtime.streamWindows.contents())) return;
    const chunk = parseAudioChunk(raw);
    if (!chunk) return;
    runtime.controller.ingestChunk(chunk);
  });
  ipcMain.on(IpcChannels.streamFailed, (_event, raw: unknown) => {
    if (!isWindowSender(_event, runtime.streamWindows.contents())) return;
    const payload = parseCaptureFailed(raw);
    if (!payload) return;
    runtime.controller.notifyCaptureFailed(payload.sessionId, payload.message);
  });
}

function sessionBusy(state: SessionState): boolean {
  return state === "preparing" || state === "running" || state === "degraded" || state === "stopping";
}
