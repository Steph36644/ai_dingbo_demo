import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseAnalysisSettings } from "@shared/config/analysisSettings";
import { ANALYSIS_DEFAULTS, RECONNECT, STREAM_PLAYBACK } from "@shared/config/defaults";
import type { SettingsSnapshot, SettingsUpdateResult } from "@shared/contracts/ipc";

const FILE_NAME = "settings.json";
const NOTE_PERSISTED = "窗口、间隔和直播流外放保存在本机应用数据目录的 settings.json。盯播进行中不能改窗口和间隔，外放可以随时开关。讯飞凭据不在这个文件里。";
const NOTE_MEMORY = "当前没有配置应用数据目录，窗口、间隔和直播流外放只留在内存。";
const SENSITIVE_KEY = /token|secret|password|authorization|apikey|api_key|(^|_)key$/i;

let windowMs: number = ANALYSIS_DEFAULTS.windowMs;
let intervalMs: number = ANALYSIS_DEFAULTS.intervalMs;
let streamAudible: boolean = STREAM_PLAYBACK.audible;
let directory: string | null = null;

export function analysisTiming(): { windowMs: number; intervalMs: number } {
  return { windowMs, intervalMs };
}

export function streamPlaybackAudible(): boolean {
  return streamAudible;
}

export function settingsFilePath(): string | null {
  return directory ? path.join(directory, FILE_NAME) : null;
}

export function configureSettingsPersistence(dir: string): void {
  directory = dir;
  loadPersistedSettings();
}

export function currentSettings(): SettingsSnapshot {
  return {
    windowMs,
    intervalMs,
    windowMsRange: ANALYSIS_DEFAULTS.windowMsRange,
    intervalMsRange: ANALYSIS_DEFAULTS.intervalMsRange,
    windowEditable: true,
    intervalEditable: true,
    persisted: directory != null,
    note: directory ? NOTE_PERSISTED : NOTE_MEMORY,
    streamAudible,
    asrOptions: [
      {
        id: "fake",
        label: "Fake ASR",
        detail: "确定性脚本，适合开发和测试。不代表听写结果。",
      },
      {
        id: "funasr",
        label: "FunASR 本地",
        detail: "开始后在 CPU 上加载 paraformer-zh-streaming。权重缓存在本机用户目录，不进仓库。",
      },
      {
        id: "xfyun",
        label: "讯飞 RTASR 云端",
        detail: "实时语音转写标准版，音频会发送至讯飞。未配置 APPID 和 APIKey 时不能开始；不支持会话级热词。",
      },
    ],
    reconnect: {
      backoffMs: RECONNECT.backoffMs,
      maxAttempts: RECONNECT.maxAttempts,
      autoReconnect: true,
    },
  };
}

export function applySettingsUpdate(input: unknown): SettingsUpdateResult {
  if (!input || typeof input !== "object") {
    return reject("invalid", "设置参数不合法。");
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => SENSITIVE_KEY.test(key))) {
    return reject("invalid", "设置文件不接受密钥。");
  }
  const hasTiming = "windowMs" in record || "intervalMs" in record;
  const hasAudible = "streamAudible" in record;
  if (!hasTiming && !hasAudible) return reject("invalid", "设置参数不合法。只接受窗口、间隔和直播流外放。");
  if (hasAudible && typeof record.streamAudible !== "boolean") {
    return reject("invalid", "直播流外放只能打开或关闭。");
  }
  let nextWindow = windowMs;
  let nextInterval = intervalMs;
  if (hasTiming) {
    const parsed = parseAnalysisSettings({ windowMs: record.windowMs, intervalMs: record.intervalMs });
    if (!parsed.ok) return reject("invalid", parsed.message);
    nextWindow = parsed.windowMs;
    nextInterval = parsed.intervalMs;
  }
  const nextAudible = hasAudible ? record.streamAudible === true : streamAudible;
  const previous = { windowMs, intervalMs, streamAudible };
  windowMs = nextWindow;
  intervalMs = nextInterval;
  streamAudible = nextAudible;
  try {
    persistSettings();
  } catch {
    windowMs = previous.windowMs;
    intervalMs = previous.intervalMs;
    streamAudible = previous.streamAudible;
    return reject("persist_failed", "没能写入 settings.json，设置保持原值。");
  }
  return {
    ok: true,
    message: savedMessage(hasTiming, hasAudible),
    settings: currentSettings(),
  };
}

export function rejectSettingsUpdate(code: SettingsUpdateResult["code"], message: string): SettingsUpdateResult {
  return reject(code ?? "invalid", message);
}

export function resetAnalysisSettings(): void {
  windowMs = ANALYSIS_DEFAULTS.windowMs;
  intervalMs = ANALYSIS_DEFAULTS.intervalMs;
  streamAudible = STREAM_PLAYBACK.audible;
  directory = null;
}

function loadPersistedSettings(): void {
  const file = settingsFilePath();
  if (!file) return;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => SENSITIVE_KEY.test(key))) return;
  if (record.schemaVersion !== 1) return;
  const parsed = parseAnalysisSettings({ windowMs: record.windowMs, intervalMs: record.intervalMs });
  if (!parsed.ok) return;
  windowMs = parsed.windowMs;
  intervalMs = parsed.intervalMs;
  streamAudible = typeof record.streamAudible === "boolean" ? record.streamAudible : STREAM_PLAYBACK.audible;
}

function persistSettings(): void {
  const file = settingsFilePath();
  if (!file || !directory) return;
  const body = `${JSON.stringify({ schemaVersion: 1, windowMs, intervalMs, streamAudible }, null, 2)}\n`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // 部分系统忽略权限位。
  }
}

function savedMessage(timing: boolean, audible: boolean): string {
  const memory = "当前没有落盘目录，重启后会回到默认值。";
  if (audible && !timing) {
    const state = streamAudible ? "已打开直播流外放。" : "已关闭直播流外放。";
    return directory ? state : `${state}${memory}`;
  }
  if (audible && timing) {
    return directory ? "已保存窗口、间隔和直播流外放。" : `已更新窗口、间隔和直播流外放。${memory}`;
  }
  return directory ? "已保存窗口和间隔。" : `已更新窗口和间隔。${memory}`;
}

function reject(code: NonNullable<SettingsUpdateResult["code"]>, message: string): SettingsUpdateResult {
  return { ok: false, code, message, settings: currentSettings() };
}
