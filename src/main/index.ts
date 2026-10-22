import path from "node:path";
import os from "node:os";
import { app, BrowserWindow } from "electron";
import { IpcChannels } from "@shared/contracts/ipc";
import type { AudioSourceId } from "@shared/contracts/audio";
import { utterancesFor } from "@shared/fixtures/issueUtterances";
import { SimulatedAudioPump } from "./audio/simulatedSource";
import { LoopbackAudioPump } from "./audio/loopbackSource";
import { StreamAudioPump } from "./audio/streamSource";
import { StreamWindowManager } from "./audio/streamWindow";
import { FakeAsrAdapter } from "./asr/FakeAsrAdapter";
import { AsrAdapterManager } from "./asr/AsrAdapterManager";
import { createMainWindow, hardenContents, installDisplayMediaHandler } from "./app";
import { listAudioDevices } from "./devices";
import { FrameworkStore } from "./framework/FrameworkStore";
import { registerIpc } from "./ipc";
import { createProductionSecretStore } from "./security/safeStorageBackend";
import { SessionController } from "./session/SessionController";
import { configureSettingsPersistence, streamPlaybackAudible } from "./settings";
import { logEvent } from "./security/log";
import { StagePreferencesStore } from "./stage/preferences";
import { StageWindowManager } from "./stage/StageWindowManager";

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 直播流播放窗要在无人点击的情况下开始播放。主窗自身没有自动播放的媒体。
  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
  // Windows 会把被挡住的窗口算成 hidden。隐藏直播窗如果真的 hide()，
  // 扬声器仍有声，WebAudio 旁路却是全零，FunASR 不出字幕。
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
  let mainWindow: BrowserWindow | null = null;
  const asr = new AsrAdapterManager();
  const frameworks = new FrameworkStore();
  const streamWindows = new StreamWindowManager({
    preloadPath: path.join(__dirname, "../preload/index.js"),
    audible: () => streamPlaybackAudible(),
    getControlWindow: () => mainWindow,
    onCaptureStalled: (notice) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send(IpcChannels.streamCaptureStalled, notice);
    },
    onUserHid: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send(IpcChannels.streamWindowVisibility, { visible: false });
    },
  });
  let replayRoot = path.join(os.tmpdir(), "ai-dingbo");
  const controller = new SessionController({
    frameworks,
    getReplayRoot: () => replayRoot,
    createAsr: (id, options) => {
      if (id === "fake") return new FakeAsrAdapter({ loop: true, utterances: utterancesFor(options) });
      return asr.create(id);
    },
    createPump: (source: AudioSourceId, options) => {
      if (source === "simulated") return new SimulatedAudioPump({ loop: true, utterances: utterancesFor(options) });
      if (source === "stream") {
        return new StreamAudioPump({
          url: options.streamUrl ?? "",
          open: (sessionId, url) => streamWindows.open(sessionId, url),
          close: () => streamWindows.close(),
          reload: () => streamWindows.reload(),
          reveal: () => streamWindows.reveal(),
        });
      }
      return new LoopbackAudioPump({
        assess: () => listAudioDevices(),
        requestCapture: (sessionId) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IpcChannels.beginCapture, { sessionId });
          }
        },
      });
    },
  });

  // 构造不访问显示器模块。订阅在 StageWindowManager 内部等到 app ready 之后。
  const stageManager = new StageWindowManager({
    getControlWindow: () => mainWindow,
    getStageView: () => controller.stageView(),
    getTranscript: () => controller.getTranscript(),
    onStageClosed: () => {
      // Stage 被关不掉会话。Control 还在则应用不退出。
    },
    onDisplayDisconnected: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IpcChannels.stageDisplayDisconnected, { displayLabel: null });
      }
    },
    onLoadFailed: (message) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IpcChannels.stageLoadFailed, { message });
      }
    },
  });

  const openWindow = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
      return;
    }
    mainWindow = createMainWindow({
      onControlClose: () => ({
        state: controller.snapshot().state,
        stop: () => controller.stop(),
        closeStage: () => stageManager.close(),
      }),
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  };

  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on("web-contents-created", (_event, contents) => {
    hardenContents(contents);
  });

  app.whenReady().then(() => {
    replayRoot = app.getPath("userData");
    configureSettingsPersistence(replayRoot);
    const secrets = createProductionSecretStore(replayRoot, !app.isPackaged);
    asr.configureXfyun({ getCredentials: () => secrets.readXfyunCredentials() });
    const bundled = path.join(app.getAppPath(), "frameworks", "example-framework.v0.json");
    const fallback = path.join(process.cwd(), "frameworks", "example-framework.v0.json");
    frameworks.loadFirstAvailable(bundled === fallback ? [bundled] : [bundled, fallback]);
    installDisplayMediaHandler();
    const stagePreferences = new StagePreferencesStore(replayRoot);
    registerIpc({
      getWindow: () => mainWindow,
      controller,
      asr,
      frameworks,
      secrets,
      stageManager,
      stagePreferences,
      streamWindows,
    });
    openWindow();
    logEvent("info", "app", "ready", { platform: process.platform });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) openWindow();
    });
  }).catch((error: unknown) => {
    logEvent("error", "app", "ready_failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
  });

  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    const state = controller.snapshot().state;
    if (state === "idle" || state === "completed" || state === "error") {
      stageManager.close();
      streamWindows.close();
      return;
    }
    event.preventDefault();
    quitting = true;
    stageManager.close();
    streamWindows.close();
    void controller.stop().finally(() => app.quit());
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
