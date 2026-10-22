import { beforeEach, describe, expect, it, vi } from "vitest";
import { IpcChannels, type IpcInvokeMap } from "../../src/shared/contracts/ipc";

const { handlers, events } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  events: new Map<string, (...args: any[]) => any>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn),
    on: (name: string, fn: (...args: any[]) => any) => events.set(name, fn),
  },
  app: { whenReady: () => Promise.resolve() },
  dialog: {}, screen: {},
}));
import { registerIpc, type IpcRuntime } from "../../src/main/ipc";

/** Every invoke channel in the contract. A new channel that is not registered fails this list. */
const INVOKE_CHANNELS = [
  IpcChannels.actionsGetConfig,
  IpcChannels.actionsSaveConfig,
  IpcChannels.actionsGet,
  IpcChannels.actionsResolve,
  IpcChannels.listDevices,
  IpcChannels.sessionStart,
  IpcChannels.sessionStop,
  IpcChannels.sessionGet,
  IpcChannels.transcriptGet,
  IpcChannels.replayLoadCurrent,
  IpcChannels.replayListSessions,
  IpcChannels.replayLoadBySessionId,
  IpcChannels.replayRenameSession,
  IpcChannels.settingsGet,
  IpcChannels.settingsUpdate,
  IpcChannels.asrHealth,
  IpcChannels.frameworkLoad,
  IpcChannels.frameworkSelect,
  IpcChannels.analysisGet,
  IpcChannels.issueMarkRead,
  IpcChannels.issueRulesGet,
  IpcChannels.issueRulesSave,
  IpcChannels.issueRulesDelete,
  IpcChannels.issueRulesActivate,
  IpcChannels.secretsStatus,
  IpcChannels.secretsSet,
  IpcChannels.secretsClear,
  IpcChannels.xfyunSecretsStatus,
  IpcChannels.xfyunSecretsSet,
  IpcChannels.xfyunSecretsClear,
  IpcChannels.stageOpen,
  IpcChannels.stageClose,
  IpcChannels.stageGetState,
  IpcChannels.stageDisplayList,
  IpcChannels.stageSet,
  IpcChannels.stageGetTranscript,
  IpcChannels.stagePreferencesGet,
  IpcChannels.stagePreferencesSet,
  IpcChannels.streamWindowGet,
  IpcChannels.streamWindowSet,
] as const satisfies readonly (keyof IpcInvokeMap)[];

type MissingInvoke = Exclude<keyof IpcInvokeMap, (typeof INVOKE_CHANNELS)[number]>;
const invokeChannelsCoverContract: MissingInvoke extends never ? true : MissingInvoke = true;
void invokeChannelsCoverContract;

const STAGE_READ = [IpcChannels.stageGetState, IpcChannels.stageGetTranscript];

describe("Main window role boundary", () => {
  const control = { mainFrame: {}, isDestroyed: () => false, send: vi.fn() };
  const stage = { mainFrame: {}, isDestroyed: () => false, send: vi.fn() };
  const ingestChunk = vi.fn();
  const notifyCaptureFailed = vi.fn();
  const controller = {
    actions: { onChange: vi.fn() },
    getTranscript: () => ({ sessionId: "s", finals: [], partial: null }),
    stageView: () => ({ stageLabel: "直播中" }),
    snapshot: () => ({ state: "idle" }),
    ingestChunk,
    notifyCaptureFailed,
    onState: vi.fn(),
    onTranscript: vi.fn(),
    onPresentation: vi.fn(),
    onLevel: vi.fn(),
    onIssues: vi.fn(),
    onCoverage: vi.fn(),
    onStage: vi.fn(),
  };
  beforeEach(() => {
    handlers.clear(); events.clear();
    registerIpc({
      getWindow: () => ({ isDestroyed: () => false, webContents: control }),
      controller,
      stageManager: { contents: () => stage },
      streamWindows: { contents: () => null, isVisible: () => false, setVisible: (visible: boolean) => visible },
      asr: {}, frameworks: {}, secrets: {},
    } as unknown as IpcRuntime);
  });
  it("registers every invoke channel, including replay rename", () => {
    expect([...handlers.keys()].sort()).toEqual([...INVOKE_CHANNELS].sort());
    expect(handlers.has(IpcChannels.replayRenameSession)).toBe(true);
  });
  it("Stage may read its view and captions, but every other invoke is rejected", () => {
    const event = { sender: stage, senderFrame: stage.mainFrame };
    expect(handlers.get(IpcChannels.stageGetState)!(event)).toEqual({ stageLabel: "直播中" });
    expect(handlers.get(IpcChannels.stageGetTranscript)!(event)).toMatchObject({ sessionId: "s" });
    for (const channel of INVOKE_CHANNELS) {
      const fn = handlers.get(channel);
      expect(fn, channel).toBeTypeOf("function");
      if (STAGE_READ.includes(channel as typeof STAGE_READ[number])) continue;
      expect(() => fn!(event, {}), channel).toThrow("当前窗口无权");
    }
  });
  it("Control main frame works; subframes, foreign and stale windows fail", () => {
    const fn = handlers.get(IpcChannels.sessionGet)!;
    expect(fn({ sender: control, senderFrame: control.mainFrame })).toEqual({ state: "idle" });
    expect(() => fn({ sender: control, senderFrame: {} })).toThrow();
    expect(() => fn({ sender: {}, senderFrame: control.mainFrame })).toThrow();
    expect(() => fn({ sender: stage, senderFrame: stage.mainFrame })).toThrow();
    const rename = handlers.get(IpcChannels.replayRenameSession)!;
    expect(() => rename({ sender: stage, senderFrame: stage.mainFrame }, {})).toThrow("当前窗口无权");
  });
  it("audio push channels accept only the Control main frame", () => {
    const chunk = events.get(IpcChannels.chunk)!;
    const failed = events.get(IpcChannels.captureFailed)!;
    const samples = new Float32Array([0.1]);
    const audio = { sessionId: "s", sampleRate: 16000, channels: 1 as const, capturedAtMs: 1, samples };
    chunk({ sender: stage, senderFrame: stage.mainFrame }, audio);
    failed({ sender: {}, senderFrame: control.mainFrame }, { sessionId: "s", message: "x" });
    expect(ingestChunk).not.toHaveBeenCalled();
    expect(notifyCaptureFailed).not.toHaveBeenCalled();
    chunk({ sender: control, senderFrame: control.mainFrame }, audio);
    failed({ sender: control, senderFrame: control.mainFrame }, { sessionId: "s", message: "x" });
    expect(ingestChunk).toHaveBeenCalledOnce();
    expect(notifyCaptureFailed).toHaveBeenCalledWith("s", "x");
  });
});
