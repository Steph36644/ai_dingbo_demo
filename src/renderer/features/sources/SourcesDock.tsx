import type { AsrHealth, AsrId } from "@shared/contracts/asr";
import type { AudioSourceId, DeviceListResult } from "@shared/contracts/audio";
import type { FrameworkLoadResult } from "@shared/contracts/framework";
import type { DemoScriptId, SessionSnapshot } from "@shared/contracts/session";
import { STATE_LABEL } from "../monitor/format";

export function FrameworkSection(props: {
  framework: FrameworkLoadResult | null;
  locked: boolean;
  onSelectFramework: () => void;
}) {
  return (
    <div className="dock-section">
      <FrameworkStatus framework={props.framework} />
      <button type="button" className="ghost" onClick={props.onSelectFramework} disabled={props.locked}>
        更换框架
      </button>
    </div>
  );
}

export function AudioSourceSection(props: {
  devices: DeviceListResult | null;
  source: AudioSourceId;
  locked: boolean;
  streamUrl: string;
  streamUrlError: string | null;
  streamWindowVisible: boolean;
  streamWindowReady: boolean;
  onSource: (source: AudioSourceId) => void;
  onStreamUrl: (value: string) => void;
  onToggleStreamWindow: () => void;
}) {
  const loopbackAllowed = props.devices?.loopbackAttemptAllowed ?? false;
  const showLoopbackDetail = props.source === "loopback";

  return (
    <div className="dock-section">
      <label className={props.source === "loopback" ? "choice selected" : "choice"}>
        <input
          type="radio"
          name="source"
          checked={props.source === "loopback"}
          disabled={props.locked || !loopbackAllowed}
          onChange={() => props.onSource("loopback")}
        />
        <span>
          <strong>系统环回</strong>
          <small>{loopbackAllowed ? "收到第一帧后才进入盯播" : "当前系统不可用"}</small>
        </span>
      </label>
      <label className={props.source === "stream" ? "choice selected" : "choice"}>
        <input
          type="radio"
          name="source"
          checked={props.source === "stream"}
          disabled={props.locked}
          onChange={() => props.onSource("stream")}
        />
        <span>
          <strong>抖音直播流</strong>
          <small>粘贴 live.douyin.com 直播间链接，从直播流抽音，默认不外放</small>
        </span>
      </label>
      {props.source === "stream" ? (
        <>
          <label className="script-field">
            直播间链接
            <input
              type="text"
              value={props.streamUrl}
              disabled={props.locked}
              placeholder="https://live.douyin.com/295178185857"
              spellCheck={false}
              inputMode="url"
              aria-invalid={props.streamUrlError ? true : undefined}
              onChange={(event) => props.onStreamUrl(event.target.value)}
            />
          </label>
          {props.streamUrlError ? (
            <p className="guidance bad-text" role="status">
              {props.streamUrlError}
            </p>
          ) : null}
          <button
            type="button"
            className="ghost"
            onClick={props.onToggleStreamWindow}
            disabled={!props.streamWindowReady}
          >
            {props.streamWindowVisible ? "隐藏直播画面" : "显示直播画面"}
          </button>
          <p className="guidance">
            {props.streamWindowReady
              ? "打开后可扫码登录。显示画面和外放分开设置，切换显示不影响采音。"
              : "开始盯播后可打开直播画面，用于扫码登录。外放在设置里单独开关。"}
          </p>
        </>
      ) : null}
      <label className={props.source === "simulated" ? "choice selected" : "choice"}>
        <input
          type="radio"
          name="source"
          checked={props.source === "simulated"}
          disabled={props.locked}
          onChange={() => props.onSource("simulated")}
        />
        <span>
          <strong>模拟音频</strong>
          <small>开发注入，不是环回成功</small>
        </span>
      </label>
      {showLoopbackDetail && props.devices?.guidance ? <p className="guidance">{props.devices.guidance}</p> : null}
      {showLoopbackDetail && props.devices && props.devices.devices.length > 0 ? (
        <ul className="devices">
          {props.devices.devices.map((device) => (
            <li key={device.id}>{device.label}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function AsrSection(props: {
  asrId: AsrId;
  demoScript: DemoScriptId;
  source: AudioSourceId;
  locked: boolean;
  asrHealth: AsrHealth | null;
  healthChecking: boolean;
  onAsr: (id: AsrId) => void;
  onDemoScript: (id: DemoScriptId) => void;
  onCheckHealth: () => void;
}) {
  const scriptEnabled = props.source === "simulated" && props.asrId === "fake" && !props.locked;

  return (
    <>
      <div className="dock-section">
        <label className={props.asrId === "fake" ? "choice selected" : "choice"}>
          <input type="radio" name="asr" checked={props.asrId === "fake"} disabled={props.locked} onChange={() => props.onAsr("fake")} />
          <span>
            <strong>Fake ASR</strong>
            <small>固定口播脚本，结果可复现</small>
          </span>
        </label>
        <label className={props.asrId === "funasr" ? "choice selected" : "choice"}>
          <input type="radio" name="asr" checked={props.asrId === "funasr"} disabled={props.locked} onChange={() => props.onAsr("funasr")} />
          <span>
            <strong>FunASR 本地</strong>
            <small>本地 sidecar，CPU 加载流式模型</small>
          </span>
        </label>
        <label className={props.asrId === "xfyun" ? "choice selected" : "choice"}>
          <input type="radio" name="asr" checked={props.asrId === "xfyun"} disabled={props.locked} onChange={() => props.onAsr("xfyun")} />
          <span>
            <strong>讯飞 RTASR（云端）</strong>
            <small>需先在设置中配置 APPID / APIKey；音频会发送至讯飞</small>
          </span>
        </label>
        <label className="script-field">
          注入文稿
          <select value={props.demoScript} disabled={!scriptEnabled} onChange={(event) => props.onDemoScript(event.target.value as DemoScriptId)}>
            <option value="standard">正常口播</option>
            <option value="issues">问题样例（触雷 / 漏讲 / 长停顿）</option>
          </select>
        </label>
      </div>

      <div className="dock-section" aria-label="识别健康预检">
        <h3>开始前预检</h3>
        <p className={props.asrHealth?.ok === false ? "guidance bad-text" : "guidance"} role="status">
          {props.healthChecking
            ? props.asrId === "funasr"
              ? "正在拉起 FunASR 并加载 CPU 模型，首次检查可能较慢…"
              : "正在检查识别服务…"
            : props.asrHealth?.detail ?? "选择识别服务后会自动检查运行时就绪。"}
        </p>
        <button type="button" className="ghost" onClick={props.onCheckHealth} disabled={props.locked || props.healthChecking}>
          {props.healthChecking ? "检查中…" : "重新检查"}
        </button>
      </div>
    </>
  );
}

export function WatchControlSection(props: {
  session: SessionSnapshot | null;
  rms: number;
  busy: boolean;
  startBlockReason: string | null;
  startDisabled: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const state = props.session?.state ?? "idle";
  const meter = Math.max(0, Math.min(1, props.rms / 0.2));
  const showStart = state !== "running" && state !== "degraded" && state !== "preparing";
  const startBlockReason = showStart ? props.startBlockReason : null;

  return (
    <div className="dock-section" aria-label="盯播控制">
      {startBlockReason ? (
        <p id="start-block-reason" className="prep-reason" role="status">
          {startBlockReason}
        </p>
      ) : null}
      <div className="actions">
        {showStart ? (
          <button
            className="primary start"
            type="button"
            onClick={props.onStart}
            disabled={props.startDisabled}
            aria-describedby={startBlockReason ? "start-block-reason" : undefined}
          >
            {state === "completed" || state === "error" ? "再盯一场" : "开始盯播"}
          </button>
        ) : (
          <button className="danger stop" type="button" onClick={props.onStop} disabled={props.busy}>
            停止盯播
          </button>
        )}
      </div>
      <div className="meter" aria-hidden="true">
        {Array.from({ length: 12 }, (_, index) => (
          <i key={index} className={meter * 12 > index ? "on" : ""} />
        ))}
      </div>
      <p className="guidance">当前：{STATE_LABEL[state] ?? state}</p>
    </div>
  );
}

function FrameworkStatus({ framework }: { framework: FrameworkLoadResult | null }) {
  if (!framework) return <p className="guidance">正在读取框架…</p>;
  if (!framework.ok) return <p className="guidance bad-text">{framework.message}</p>;
  return (
    <p className="guidance">
      <strong>{framework.document.title ?? framework.document.id ?? "未命名框架"}</strong>
      <small>revision {framework.revision.slice(0, 12)}</small>
    </p>
  );
}
