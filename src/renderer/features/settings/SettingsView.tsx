import { useEffect, useRef, useState } from "react";
import { parseAnalysisSettings } from "@shared/config/analysisSettings";
import type { SettingsSnapshot, SettingsUpdateResult } from "@shared/contracts/ipc";
import type { SecretStatus } from "@shared/contracts/secrets";

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} 秒`;
}

type SettingsViewProps = {
  settings: SettingsSnapshot | null;
  xfyunSecret: SecretStatus | null;
  locked: boolean;
  onSave: (patch: { windowMs: number; intervalMs: number }) => Promise<SettingsUpdateResult>;
  onStreamAudible: (audible: boolean) => Promise<SettingsUpdateResult>;
  onClearDeprecatedCloudKey: () => Promise<SecretStatus>;
  onSetXfyunCredentials: (credentials: { appId: string; apiKey: string }) => Promise<SecretStatus>;
  onClearXfyunCredentials: () => Promise<SecretStatus>;
};

export function SettingsView({
  settings,
  xfyunSecret,
  locked,
  onSave,
  onStreamAudible,
  onClearDeprecatedCloudKey,
  onSetXfyunCredentials,
  onClearXfyunCredentials,
}: SettingsViewProps) {
  const [windowSec, setWindowSec] = useState(300);
  const [intervalSec, setIntervalSec] = useState(60);
  const [message, setMessage] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const [saving, setSaving] = useState(false);
  const xfyunAppIdRef = useRef<HTMLInputElement>(null);
  const xfyunApiKeyRef = useRef<HTMLInputElement>(null);
  const xfyunKeyLocked = locked || xfyunSecret?.editable === false;

  useEffect(() => {
    if (!settings) return;
    setWindowSec(settings.windowMs / 1000);
    setIntervalSec(settings.intervalMs / 1000);
  }, [settings]);

  if (!settings) return <p className="muted">正在读取设置…</p>;

  async function changeStreamAudible(audible: boolean) {
    setSaving(true);
    try {
      const result = await onStreamAudible(audible);
      setBad(!result.ok);
      setMessage(result.message);
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    const parsed = parseAnalysisSettings({ windowMs: Math.round(windowSec * 1000), intervalMs: Math.round(intervalSec * 1000) });
    if (!parsed.ok) {
      setBad(true);
      setMessage(parsed.message);
      return;
    }
    setSaving(true);
    try {
      const result = await onSave({ windowMs: parsed.windowMs, intervalMs: parsed.intervalMs });
      setBad(!result.ok);
      setMessage(result.message);
    } finally {
      setSaving(false);
    }
  }

  async function clearDeprecatedCloudKey() {
    setSaving(true);
    try {
      const status = await onClearDeprecatedCloudKey();
      setBad(false);
      setMessage(status.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveXfyunCredentials() {
    const appIdInput = xfyunAppIdRef.current;
    const apiKeyInput = xfyunApiKeyRef.current;
    const appId = appIdInput?.value.trim() ?? "";
    const apiKey = apiKeyInput?.value ?? "";
    if (appIdInput) appIdInput.value = "";
    if (apiKeyInput) apiKeyInput.value = "";
    if (!appId || !apiKey.trim()) {
      setBad(true);
      setMessage("请同时输入讯飞 APPID 和 APIKey。明文不会留在页面状态里。");
      return;
    }
    setSaving(true);
    try {
      const status = await onSetXfyunCredentials({ appId, apiKey });
      setBad(status.source === "none");
      setMessage(status.message);
    } finally {
      setSaving(false);
    }
  }

  async function clearXfyunCredentials() {
    setSaving(true);
    try {
      const status = await onClearXfyunCredentials();
      setBad(false);
      setMessage(status.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings">
      <header>
        <h2>设置</h2>
        <p>{settings.note}</p>
      </header>
      <label className={settings.streamAudible ? "choice selected stream-audible" : "choice stream-audible"}>
        <input
          type="checkbox"
          aria-label="直播流外放"
          checked={settings.streamAudible}
          disabled={saving}
          onChange={(event) => void changeStreamAudible(event.target.checked)}
        />
        <span>
          <strong>直播流外放</strong>
          <small>默认关闭。关闭时听不见直播声，电脑总音量不用动，字幕仍从直播流抽取。打开后只有这个直播窗出声，和是否显示画面无关。</small>
        </span>
      </label>
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label>
          分析窗口（秒）
          <input
            type="number"
            min={settings.windowMsRange[0] / 1000}
            max={settings.windowMsRange[1] / 1000}
            step={1}
            value={windowSec}
            disabled={locked || saving}
            onChange={(event) => setWindowSec(Number(event.target.value))}
          />
          <span>
            允许 {seconds(settings.windowMsRange[0])} – {seconds(settings.windowMsRange[1])}
          </span>
        </label>
        <label>
          分析间隔（秒）
          <input
            type="number"
            min={settings.intervalMsRange[0] / 1000}
            max={settings.intervalMsRange[1] / 1000}
            step={1}
            value={intervalSec}
            disabled={locked || saving}
            onChange={(event) => setIntervalSec(Number(event.target.value))}
          />
          <span>
            允许 {seconds(settings.intervalMsRange[0])} – {seconds(settings.intervalMsRange[1])}
          </span>
        </label>
        <button type="submit" disabled={locked || saving}>
          {locked ? "盯播中不可改" : "保存窗口和间隔"}
        </button>
      </form>
      <form
        className="settings-form secret-form"
        onSubmit={(event) => {
          event.preventDefault();
          void saveXfyunCredentials();
        }}
      >
        <h3>讯飞 RTASR 凭据</h3>
        <p>{xfyunSecret?.message ?? "正在读取讯飞凭据状态…"}</p>
        <p className="analysis-meta">
          状态：{secretLabel(xfyunSecret)}。APPID 和 APIKey 只交给主进程，写入独立的系统安全存储；不会回显或进入设置 JSON。
        </p>
        <label>
          讯飞 APPID
          <input
            ref={xfyunAppIdRef}
            type="password"
            name="xfyun-app-id"
            autoComplete="off"
            spellCheck={false}
            disabled={xfyunKeyLocked || saving}
            aria-label="讯飞 APPID"
          />
        </label>
        <label>
          讯飞 APIKey
          <input
            ref={xfyunApiKeyRef}
            type="password"
            name="xfyun-api-key"
            autoComplete="off"
            spellCheck={false}
            disabled={xfyunKeyLocked || saving}
            aria-label="讯飞 APIKey"
          />
          <span>提交后两个输入框会立刻清空。开发回退使用 DINGBO_XFYUN_APP_ID 和 DINGBO_XFYUN_API_KEY。</span>
        </label>
        <p className="analysis-meta">选择讯飞后，实时音频会发送至讯飞 RTASR 服务；请确认已开通服务并正确配置 IP 白名单。</p>
        <div className="secret-actions">
          <button type="submit" disabled={xfyunKeyLocked || saving}>
            {locked ? "盯播中不可改" : "保存讯飞凭据"}
          </button>
          <button type="button" className="ghost" disabled={xfyunKeyLocked || saving} onClick={() => void clearXfyunCredentials()}>
            清除讯飞凭据
          </button>
        </div>
      </form>
      <section className="settings-form secret-form deprecated-secret">
        <h3>通用云 ASR 密钥（已废弃）</h3>
        <p>
          这条密钥没有识别适配器使用，不能用来开始盯播。请只配置上面的讯飞 APPID 和 APIKey。界面不再提供填写入口，也不会读取或显示旧密钥。
        </p>
        <div className="secret-actions">
          <button type="button" className="ghost" disabled={locked || saving} onClick={() => void clearDeprecatedCloudKey()}>
            {locked ? "盯播中不可改" : "清除本机旧密钥"}
          </button>
        </div>
      </section>
      {message ? <p className={bad ? "banner bad" : "banner"}>{message}</p> : null}
      <dl>
        <div>
          <dt>当前窗口</dt>
          <dd>{seconds(settings.windowMs)}</dd>
        </div>
        <div>
          <dt>当前间隔</dt>
          <dd>{seconds(settings.intervalMs)}</dd>
        </div>
        <div>
          <dt>直播流外放</dt>
          <dd>{settings.streamAudible ? "开" : "关"}</dd>
        </div>
        <div>
          <dt>落盘</dt>
          <dd>{settings.persisted ? "settings.json" : "仅内存"}</dd>
        </div>
        <div>
          <dt>重连</dt>
          <dd>
            {settings.reconnect.backoffMs.map((item) => `${item / 1000}s`).join(" / ")}，最多 {settings.reconnect.maxAttempts} 次
            <span>{settings.reconnect.autoReconnect ? "采音或识别中断后会自动重连。" : "不会自动重连。"}</span>
          </dd>
        </div>
      </dl>
      <ul className="asr-options">
        {settings.asrOptions.map((item) => (
          <li key={item.id}>
            <strong>{item.label}</strong>
            <span>{item.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function secretLabel(secret: SecretStatus | null): string {
  if (!secret) return "未知";
  if (secret.source === "os") return "系统安全存储";
  if (secret.source === "env") return "开发环境变量";
  return "未设置";
}
