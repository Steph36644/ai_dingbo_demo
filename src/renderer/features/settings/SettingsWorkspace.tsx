import type { SettingsSnapshot, SettingsUpdateResult } from "@shared/contracts/ipc";
import type { SecretStatus } from "@shared/contracts/secrets";
import type { FrameworkLoadResult } from "@shared/contracts/framework";
import { ActionConfigPanel } from "../actions/ActionConfigPanel";
import { IssueRulePanel } from "../issues/IssueRulePanel";
import { SettingsView } from "./SettingsView";

type SettingsWorkspaceProps = {
  settings: SettingsSnapshot | null;
  xfyunSecret: SecretStatus | null;
  framework: FrameworkLoadResult | null;
  locked: boolean;
  version: string;
  onSave: (patch: { windowMs: number; intervalMs: number }) => Promise<SettingsUpdateResult>;
  onStreamAudible: (audible: boolean) => Promise<SettingsUpdateResult>;
  onClearDeprecatedCloudKey: () => Promise<SecretStatus>;
  onSetXfyunCredentials: (credentials: { appId: string; apiKey: string }) => Promise<SecretStatus>;
  onClearXfyunCredentials: () => Promise<SecretStatus>;
};

export function SettingsWorkspace(props: SettingsWorkspaceProps) {
  return (
    <div className="settings-workspace">
      <nav className="settings-nav" aria-label="设置分段">
        <a href="#settings-general">通用</a>
        <a href="#settings-asr">识别</a>
        <a href="#settings-issues">问题警告</a>
        <a href="#settings-actions">动作提醒</a>
        <a href="#settings-about">关于</a>
      </nav>
      <div className="settings-body">
        <section id="settings-general" className="settings-block">
          <h2>通用</h2>
          <SettingsView
            settings={props.settings}
            xfyunSecret={props.xfyunSecret}
            locked={props.locked}
            onSave={props.onSave}
            onStreamAudible={props.onStreamAudible}
            onClearDeprecatedCloudKey={props.onClearDeprecatedCloudKey}
            onSetXfyunCredentials={props.onSetXfyunCredentials}
            onClearXfyunCredentials={props.onClearXfyunCredentials}
          />
        </section>
        <section id="settings-issues" className="settings-block">
          <h2>问题警告</h2>
          <IssueRulePanel framework={props.framework} locked={props.locked} />
        </section>
        <section id="settings-actions" className="settings-block">
          <h2>动作提醒</h2>
          <p className="guidance">规则只影响中控提醒，不连 OBS / webhook，也不显示在大屏。修改后下次开始生效。</p>
          <ActionConfigPanel framework={props.framework} locked={props.locked} />
        </section>
        <section id="settings-about" className="settings-block">
          <h2>关于</h2>
          <dl className="about-list">
            <div>
              <dt>版本</dt>
              <dd>{props.version}</dd>
            </div>
            <div>
              <dt>快捷键</dt>
              <dd>Ctrl+Enter 开始 / Ctrl+Shift+Enter 停止（中控）；Esc 关闭全屏抬头屏</dd>
            </div>
            <div>
              <dt>数据位置</dt>
              <dd>本机 userData：settings.json、sessions/*.jsonl、stage-preferences.json</dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}
