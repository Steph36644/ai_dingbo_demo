import { useEffect, useState } from "react";
import type { FrameworkItem, FrameworkLoadResult } from "@shared/contracts/framework";
import type { IssueSeverity } from "@shared/contracts/issue";
import {
  BUILTIN_ISSUE_RULE_PROFILE_ID,
  cloneIssueRuleProfile,
  customRuleItemId,
  defaultIssueRuleProfile,
  type CustomKeywordRule,
  type IssueRuleProfile,
  type IssueRuleProfilesState,
} from "@shared/contracts/issueRules";
import { issueRuleBridge } from "./bridge";
import "./issueRules.css";

const RULE_LABELS: Record<string, string> = {
  "content.avoid_hit": "触雷",
  "content.must_say_missing": "必讲点漏讲",
  "pace.too_fast": "语速偏快",
  "pace.too_slow": "语速偏慢",
  "rhythm.long_pause": "超长停顿",
  "rhythm.low_density": "静音占比偏高",
  "rhythm.no_pause": "连珠炮",
};

const SEVERITY_OPTIONS: Array<{ value: IssueSeverity; label: string }> = [
  { value: "info", label: "提示" },
  { value: "warning", label: "警告" },
  { value: "critical", label: "严重" },
];

const REMINDER_OPTIONS = [
  { value: 0, label: "每次重复都提醒" },
  { value: 30_000, label: "最多每 30 秒提醒一次" },
  { value: 60_000, label: "最多每 60 秒提醒一次" },
  { value: 180_000, label: "最多每 180 秒提醒一次" },
  { value: 300_000, label: "最多每 300 秒提醒一次" },
];

function splitKeywords(raw: string): string[] {
  return [...new Set(raw.split(/[,，、\s]+/).map((word) => word.trim()).filter(Boolean))];
}

function keywordsOf(
  profile: IssueRuleProfile,
  item: FrameworkItem,
  enabled: boolean,
  fallback: string[],
): string {
  if (!enabled) return fallback.join("、");
  return (profile.keywordOverrides[item.id] ?? item.keywords).join("、");
}

function newRuleId(): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `rule-${random}`;
}

export function IssueRulePanel({
  framework,
  locked,
}: {
  framework: FrameworkLoadResult | null;
  locked: boolean;
}) {
  const [state, setState] = useState<IssueRuleProfilesState | null>(null);
  const [draft, setDraft] = useState<IssueRuleProfile | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const bridge = issueRuleBridge();
  const disabled = locked || busy || !draft;

  useEffect(() => {
    let cancelled = false;
    if (!bridge) {
      setMessage("这个页面需要在 Electron 中打开才能编辑警告方案。");
      return;
    }
    setMessage(null);
    void bridge
      .getIssueRuleProfiles()
      .then((next) => {
        if (cancelled) return;
        setState(next);
        setDraft(cloneIssueRuleProfile(next.activeProfile));
        setMessage(next.warning);
        setDirty(false);
      })
      .catch(() => {
        if (!cancelled) setMessage("问题警告方案读取失败，盯播仍可继续。");
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, locked]);

  const document = framework?.ok ? framework.document : null;
  const activeIsBuiltin = draft?.id === BUILTIN_ISSUE_RULE_PROFILE_ID;
  const draftIsActive = draft?.id === state?.activeProfileId;
  const inputsDisabled = disabled || activeIsBuiltin;

  function update(patch: Partial<IssueRuleProfile>) {
    if (!draft) return;
    setDraft({ ...draft, ...patch });
    setDirty(true);
  }

  function updateSection<K extends "avoid" | "mustSay" | "pace" | "rhythm">(
    key: K,
    patch: Partial<IssueRuleProfile[K]>,
  ) {
    if (!draft) return;
    update({ [key]: { ...draft[key], ...patch } } as unknown as Partial<IssueRuleProfile>);
  }

  function setKeywords(itemId: string, raw: string) {
    if (!draft) return;
    const words = splitKeywords(raw);
    const next = { ...draft.keywordOverrides };
    if (words.length === 0) delete next[itemId];
    else next[itemId] = words;
    update({ keywordOverrides: next });
  }

  function toggleItem(kind: "mustSay" | "avoid", itemId: string, enabled: boolean) {
    if (!draft) return;
    const current = draft[kind].disabledItemIds;
    updateSection(kind, {
      disabledItemIds: enabled ? current.filter((id) => id !== itemId) : [...new Set([...current, itemId])],
    });
  }

  function updateCustomRule(id: string, patch: Partial<CustomKeywordRule>) {
    if (!draft) return;
    update({
      customRules: draft.customRules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    });
  }

  function setOverride(kind: "titles" | "suggestions", key: string, value: string) {
    if (!draft) return;
    const next = { ...draft[kind] };
    if (value.trim() === "") delete next[key];
    else next[key] = value;
    update({ [kind]: next } as unknown as Partial<IssueRuleProfile>);
  }

  async function activate(id: string) {
    if (!bridge) return;
    setBusy(true);
    try {
      const result = await bridge.activateIssueRuleProfile(id);
      setState(result.state);
      setDraft(cloneIssueRuleProfile(result.state.activeProfile));
      setDirty(false);
      setMessage(result.message ?? null);
    } catch {
      setMessage("切换警告方案失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!bridge || !draft) return;
    setBusy(true);
    try {
      const result = await bridge.saveIssueRuleProfile(draft);
      setState(result.state);
      if (result.ok) {
        setDraft(cloneIssueRuleProfile(result.state.activeProfile));
        setDirty(false);
      }
      setMessage(result.message ?? null);
    } catch {
      setMessage("问题警告方案保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!bridge || !state) return;
    setBusy(true);
    try {
      const result = await bridge.deleteIssueRuleProfile(state.activeProfileId);
      setState(result.state);
      setDraft(cloneIssueRuleProfile(result.state.activeProfile));
      setDirty(false);
      setMessage(result.message ?? null);
    } catch {
      setMessage("删除警告方案失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  function createProfile() {
    if (!state) return;
    const next = defaultIssueRuleProfile(
      `新方案 ${state.profiles.length}`,
      newRuleId(),
      new Date().toISOString(),
    );
    setDraft(next);
    setDirty(true);
    setMessage("新方案尚未保存。调整后点「保存方案」。");
  }

  function duplicateProfile() {
    if (!draft) return;
    const next = cloneIssueRuleProfile(draft);
    next.id = newRuleId();
    next.name = `${draft.name} 副本`;
    setDraft(next);
    setDirty(true);
    setMessage("副本尚未保存。调整后点「保存方案」。");
  }

  const customItems = draft?.customRules ?? [];
  const overrideKeys = [
    ...Object.keys(RULE_LABELS).map((id) => ({ key: id, label: RULE_LABELS[id] ?? id })),
    ...customItems.map((rule) => ({ key: customRuleItemId(rule.id), label: rule.name })),
  ];

  return (
    <section className="issue-rule-panel" aria-label="问题警告方案">
      <p className="guidance">
        警告标准保存在本机，可按直播场景切换。修改从下次开始盯播生效；盯播中不可修改。
      </p>
      {message ? <p role="status" className="guidance">{message}</p> : null}
      {!bridge ? null : !draft ? (
        <p className="guidance">正在读取警告方案…</p>
      ) : (
        <>
          <div className="issue-rule-bar">
            <label>
              当前方案
              <select
                value={state?.activeProfileId ?? BUILTIN_ISSUE_RULE_PROFILE_ID}
                disabled={disabled || dirty}
                onChange={(event) => void activate(event.target.value)}
              >
                {(state?.profiles ?? []).map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                    {profile.builtin ? "（内置）" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              方案名称
              <input
                type="text"
                value={draft.name}
                maxLength={40}
                disabled={inputsDisabled}
                onChange={(event) => update({ name: event.target.value })}
              />
            </label>
            <div className="issue-rule-actions">
              <button type="button" className="ghost" disabled={disabled} onClick={createProfile}>
                新建方案
              </button>
              <button type="button" className="ghost" disabled={disabled} onClick={duplicateProfile}>
                复制方案
              </button>
              <button
                type="button"
                className="ghost"
                disabled={disabled || activeIsBuiltin || !draftIsActive}
                onClick={() => void remove()}
              >
                删除方案
              </button>
              <button
                type="button"
                disabled={disabled || !dirty || activeIsBuiltin}
                onClick={() => void save()}
              >
                保存方案
              </button>
            </div>
          </div>
          {activeIsBuiltin ? (
            <p className="guidance">内置方案只读。点「复制方案」生成本机可编辑的副本。</p>
          ) : null}

          <details className="issue-rule-fields" open>
            <summary>关键词类规则</summary>
            <p className="guidance">勾选表示参与警告；关键词可改，命中任意一个就提醒。</p>
            {!document ? (
              <p className="guidance">当前没有可用的话术框架，加载框架后可编辑关键词。</p>
            ) : (
              <>
                <h3>必讲点</h3>
                {document.must_say.map((item) => {
                  const enabled = !draft.mustSay.disabledItemIds.includes(item.id);
                  return (
                    <div className="keyword-row" key={item.id}>
                      <label className="rule-display-row">
                        <input
                          type="checkbox"
                          checked={enabled}
                          disabled={inputsDisabled}
                          onChange={(event) => toggleItem("mustSay", item.id, event.target.checked)}
                        />
                        <span>{item.text}</span>
                      </label>
                      <input
                        type="text"
                        className="rule-text"
                        value={keywordsOf(draft, item, enabled, item.keywords)}
                        disabled={inputsDisabled || !enabled}
                        onChange={(event) => setKeywords(item.id, event.target.value)}
                      />
                      <small>判定：{enabled ? `命中「${keywordsOf(draft, item, enabled, item.keywords)}」即提醒漏讲` : "已关闭"}</small>
                    </div>
                  );
                })}
                <h3>禁讲点</h3>
                {document.avoid.map((item) => {
                  const enabled = !draft.avoid.disabledItemIds.includes(item.id);
                  return (
                    <div className="keyword-row" key={item.id}>
                      <label className="rule-display-row">
                        <input
                          type="checkbox"
                          checked={enabled}
                          disabled={inputsDisabled}
                          onChange={(event) => toggleItem("avoid", item.id, event.target.checked)}
                        />
                        <span>{item.text}</span>
                      </label>
                      <input
                        type="text"
                        className="rule-text"
                        value={keywordsOf(draft, item, enabled, item.keywords)}
                        disabled={inputsDisabled || !enabled}
                        onChange={(event) => setKeywords(item.id, event.target.value)}
                      />
                      <small>判定：{enabled ? `命中「${keywordsOf(draft, item, enabled, item.keywords)}」即提醒` : "已关闭"}</small>
                    </div>
                  );
                })}
              </>
            )}
          </details>

          <details className="issue-rule-fields" open>
            <summary>自定义关键词规则</summary>
            <p className="guidance">例如「禁止承诺发货时效」。命中后按同样的关键词规则提醒。</p>
            {customItems.map((rule) => (
              <div className="custom-rule" key={rule.id}>
                <label className="rule-display-row">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    disabled={inputsDisabled}
                    onChange={(event) => updateCustomRule(rule.id, { enabled: event.target.checked })}
                  />
                  启用此规则
                </label>
                <input
                  type="text"
                  value={rule.name}
                  maxLength={40}
                  disabled={inputsDisabled}
                  placeholder="规则名称"
                  onChange={(event) => updateCustomRule(rule.id, { name: event.target.value })}
                />
                <input
                  type="text"
                  className="rule-text"
                  value={rule.keywords.join("、")}
                  disabled={inputsDisabled}
                  placeholder="关键词，用逗号分隔"
                  onChange={(event) => updateCustomRule(rule.id, { keywords: splitKeywords(event.target.value) })}
                />
                <select
                  value={rule.severity}
                  disabled={inputsDisabled}
                  onChange={(event) =>
                    updateCustomRule(rule.id, { severity: event.target.value as IssueSeverity })
                  }
                >
                  {SEVERITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={rule.suggestion}
                  maxLength={200}
                  disabled={inputsDisabled}
                  placeholder="建议（可空）"
                  onChange={(event) => updateCustomRule(rule.id, { suggestion: event.target.value })}
                />
                <small>判定：命中「{rule.keywords.join("、") || "未填写"}」即提醒</small>
                <button
                  type="button"
                  className="ghost"
                  disabled={inputsDisabled}
                  onClick={() =>
                    update({ customRules: draft.customRules.filter((item) => item.id !== rule.id) })
                  }
                >
                  删除
                </button>
              </div>
            ))}
            <button
              type="button"
              className="ghost"
              disabled={inputsDisabled || customItems.length >= 30}
              onClick={() =>
                update({
                  customRules: [
                    ...draft.customRules,
                    {
                      id: newRuleId(),
                      name: "新规则",
                      keywords: [],
                      severity: "warning",
                      suggestion: "",
                      enabled: true,
                    },
                  ],
                })
              }
            >
              新增规则
            </button>
          </details>

          <details className="issue-rule-fields" open>
            <summary>语速与节奏阈值</summary>
            <h3>语速</h3>
            <label className="rule-display-row">
              <input
                type="checkbox"
                checked={draft.pace.enabled}
                disabled={inputsDisabled}
                onChange={(event) => updateSection("pace", { enabled: event.target.checked })}
              />
              启用语速警告
            </label>
            <label>
              严重度
              <select
                value={draft.pace.severity ?? "auto"}
                disabled={inputsDisabled}
                onChange={(event) =>
                  updateSection("pace", {
                    severity: event.target.value === "auto" ? null : (event.target.value as IssueSeverity),
                  })
                }
              >
                <option value="auto">按偏差自动</option>
                {SEVERITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="rule-thresholds">
              <label>
                下限（字/分）
                <input
                  type="number"
                  min={1}
                  max={2000}
                  value={draft.pace.min ?? ""}
                  placeholder="沿用框架"
                  disabled={inputsDisabled}
                  onChange={(event) =>
                    updateSection("pace", {
                      min: event.target.value === "" ? null : Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                上限（字/分）
                <input
                  type="number"
                  min={1}
                  max={2000}
                  value={draft.pace.max ?? ""}
                  placeholder="沿用框架"
                  disabled={inputsDisabled}
                  onChange={(event) =>
                    updateSection("pace", {
                      max: event.target.value === "" ? null : Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                偏差阈值（%）
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round(draft.pace.deviationInfoRatio * 100)}
                  disabled={inputsDisabled}
                  onChange={(event) =>
                    updateSection("pace", {
                      deviationInfoRatio: Number(event.target.value) / 100,
                    })
                  }
                />
              </label>
            </div>
            <h3>节奏</h3>
            <label className="rule-display-row">
              <input
                type="checkbox"
                checked={draft.rhythm.enabled}
                disabled={inputsDisabled}
                onChange={(event) => updateSection("rhythm", { enabled: event.target.checked })}
              />
              启用节奏警告
            </label>
            <label>
              严重度
              <select
                value={draft.rhythm.severity}
                disabled={inputsDisabled}
                onChange={(event) =>
                  updateSection("rhythm", { severity: event.target.value as IssueSeverity })
                }
              >
                {SEVERITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="rule-thresholds">
              <label className="rule-display-row">
                <input
                  type="checkbox"
                  checked={draft.rhythm.longPauseEnabled}
                  disabled={inputsDisabled}
                  onChange={(event) =>
                    updateSection("rhythm", { longPauseEnabled: event.target.checked })
                  }
                />
                超长停顿
              </label>
              <label>
                阈值（秒）
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={Math.round(draft.rhythm.longSilenceMs / 1000)}
                  disabled={inputsDisabled}
                  onChange={(event) =>
                    updateSection("rhythm", { longSilenceMs: Math.round(Number(event.target.value) * 1000) })
                  }
                />
              </label>
              <label className="rule-display-row">
                <input
                  type="checkbox"
                  checked={draft.rhythm.lowDensityEnabled}
                  disabled={inputsDisabled}
                  onChange={(event) =>
                    updateSection("rhythm", { lowDensityEnabled: event.target.checked })
                  }
                />
                静音占比偏高
              </label>
              <label>
                静音占比（%）
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round(draft.rhythm.highSilenceRatio * 100)}
                  disabled={inputsDisabled}
                  onChange={(event) =>
                    updateSection("rhythm", { highSilenceRatio: Number(event.target.value) / 100 })
                  }
                />
              </label>
              <label className="rule-display-row">
                <input
                  type="checkbox"
                  checked={draft.rhythm.noPauseEnabled}
                  disabled={inputsDisabled}
                  onChange={(event) => updateSection("rhythm", { noPauseEnabled: event.target.checked })}
                />
                连珠炮
              </label>
              <label>
                语音占比（%）
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round(draft.rhythm.highSpeechRatio * 100)}
                  disabled={inputsDisabled}
                  onChange={(event) =>
                    updateSection("rhythm", { highSpeechRatio: Number(event.target.value) / 100 })
                  }
                />
              </label>
              <label>
                密集语音时长（秒）
                <input
                  type="number"
                  min={15}
                  max={300}
                  value={Math.round(draft.rhythm.minDenseSpeechMs / 1000)}
                  disabled={inputsDisabled}
                  onChange={(event) =>
                    updateSection("rhythm", {
                      minDenseSpeechMs: Math.round(Number(event.target.value) * 1000),
                    })
                  }
                />
              </label>
              <label>
                句间停顿（毫秒）
                <input
                  type="number"
                  min={200}
                  max={5000}
                  value={draft.rhythm.maxSentenceGapMs}
                  disabled={inputsDisabled}
                  onChange={(event) =>
                    updateSection("rhythm", { maxSentenceGapMs: Number(event.target.value) })
                  }
                />
              </label>
            </div>
          </details>

          <details className="issue-rule-fields" open>
            <summary>展示与提醒参数</summary>
            <p className="guidance">同一问题重复出现时仍会提醒，卡片会累加次数。这里只控制提醒的最小间隔。</p>
            <label>
              重复提醒间隔
              <select
                value={draft.repeatReminderIntervalMs}
                disabled={inputsDisabled}
                onChange={(event) =>
                  update({ repeatReminderIntervalMs: Number(event.target.value) })
                }
              >
                {REMINDER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <h3>标题与建议文案</h3>
            {overrideKeys.map((rule) => (
              <div className="custom-rule" key={rule.key}>
                <strong>{rule.label}</strong>
                <input
                  type="text"
                  value={draft.titles[rule.key] ?? ""}
                  maxLength={60}
                  placeholder="自定义标题（留空用默认）"
                  disabled={inputsDisabled}
                  onChange={(event) => setOverride("titles", rule.key, event.target.value)}
                />
                <input
                  type="text"
                  value={draft.suggestions[rule.key] ?? ""}
                  maxLength={200}
                  placeholder="自定义建议（留空用默认）"
                  disabled={inputsDisabled}
                  onChange={(event) => setOverride("suggestions", rule.key, event.target.value)}
                />
              </div>
            ))}
          </details>

          {dirty ? <p className="guidance">有未保存的修改。点「保存方案」后下次开始盯播生效。</p> : null}
        </>
      )}
    </section>
  );
}
