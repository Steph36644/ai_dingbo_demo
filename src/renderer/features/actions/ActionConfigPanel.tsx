import { useEffect, useState } from "react";
import type { ActionConfig, ActionRule } from "@shared/contracts/actions";
import type { FrameworkLoadResult } from "@shared/contracts/framework";
import "./actions.css";
import { actionBridge } from "./bridge";

function selectedStageIds(rule: ActionRule): string[] {
  if (rule.stageIds && rule.stageIds.length > 0) return rule.stageIds;
  return rule.stageId ? [rule.stageId] : [];
}

export function ActionConfigPanel({ framework, locked }: { framework: FrameworkLoadResult | null; locked: boolean }) {
  const [draft, setDraft] = useState<ActionConfig | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const revision = framework?.ok ? framework.revision : null;
  useEffect(() => {
    let cancelled = false;
    setDraft(null); setDirty(false); setWarning(null);
    const bridge = actionBridge();
    if (bridge) void bridge.getActionConfig().then(result => {
      if (cancelled) return;
      setDraft(result.config); setWarning(result.warning);
    }).catch(() => { if (!cancelled) setWarning("动作规则读取失败，盯播仍可继续。"); });
    return () => { cancelled = true; };
  }, [revision, locked]);

  function update(patch: Partial<ActionConfig>) {
    if (!draft) return;
    setDraft({ ...draft, ...patch }); setDirty(true);
  }
  function updateRule(id: string, patch: Partial<ActionRule>) {
    if (draft) update({ rules: draft.rules.map(rule => rule.id === id ? { ...rule, ...patch } : rule) });
  }
  async function save() {
    const bridge = actionBridge();
    if (!draft || !bridge) return;
    setSaving(true);
    try {
      const result = await bridge.saveActionConfig(draft);
      setWarning(result.ok ? "已保存，下次开始盯播时生效。" : result.message ?? "保存失败");
      if (result.ok) setDirty(false);
    } catch { setWarning("动作规则保存失败，请重试。"); }
    finally { setSaving(false); }
  }
  const stages = framework?.ok ? framework.document.stages ?? [] : [];
  const items = framework?.ok ? framework.document.must_say : [];
  return (
    <section className="action-config" aria-label="动作提醒配置">
      <h2>动作提醒</h2>
      <p className="guidance">仅在中控显示。确认表示已处理提醒，不会推流或发券。</p>
      <p className="guidance">保存后的修改从下次开始盯播生效。阶段可多选（讲品或促单均可），不必锁死一个阶段。冷却默认 180 秒；冷却没结束时，新说法也不会提前再提醒。</p>
      {warning ? <p role="status" className="guidance">{warning}</p> : null}
      {!draft ? <p className="guidance">正在读取配置…</p> : (
        <fieldset disabled={locked || saving || !framework?.ok}>
          <label className="action-check">
            <input type="checkbox" checked={draft.enabled} onChange={e => update({ enabled: e.target.checked })} />
            启用动作提醒
          </label>
          {draft.rules.map(rule => (
            <details key={rule.id} open={rule.enabled}>
              <summary>{rule.kind === "stream.push_suggested" ? "推流建议" : "发券建议"} · {rule.enabled ? "已选择" : "未选择"}</summary>
              <label className="action-check">
                <input type="checkbox" checked={rule.enabled} onChange={e => updateRule(rule.id, { enabled: e.target.checked })} />
                启用此规则
              </label>
              <p className="guidance">目标阶段（可多选）。都不选表示不限阶段。</p>
              {stages.length ? stages.map(stage => <label key={stage.id} className="action-check">
                <input type="checkbox" checked={selectedStageIds(rule).includes(stage.id)} onChange={e => {
                  const current = selectedStageIds(rule);
                  const stageIds = e.target.checked ? [...current, stage.id] : current.filter(id => id !== stage.id);
                  updateRule(rule.id, { stageIds, stageId: stageIds.length === 1 ? stageIds[0] : null });
                }} />
                {stage.name}
              </label>) : <p className="guidance">当前框架没有阶段，提醒不限阶段。</p>}
              <p className="guidance">讲点可选。不勾选时，听到上链接、几号链接、小黄车、直接拍会提醒推流；听到发券或倒计时、就这一次会提醒发券。只说卖点不够，除非同一分析窗里还有链接或价格。勾选后，这些讲点要全部覆盖才会按讲点提醒。价格不是硬门槛。</p>
              {items.map(item => <label key={item.id} className="action-check">
                <input type="checkbox" checked={rule.requiredItemIds.includes(item.id)} onChange={e => updateRule(rule.id, {
                  requiredItemIds: e.target.checked ? [...rule.requiredItemIds, item.id] : rule.requiredItemIds.filter(id => id !== item.id),
                })} />
                {item.text}
              </label>)}
              <label className="script-field">冷却秒数（30–3600，建议 180）
                <input type="number" min={30} max={3600} step={1} value={rule.cooldownSeconds}
                  onChange={e => updateRule(rule.id, { cooldownSeconds: Number(e.target.value) })} />
              </label>
              {rule.kind === "coupon.issue_suggested" ? <p className="guidance">还需当前分析窗无禁讲命中；识别质量不足时不提醒。</p> : null}
            </details>
          ))}
          <button type="button" disabled={!dirty} onClick={() => void save()}>{saving ? "保存中…" : "保存动作规则"}</button>
        </fieldset>
      )}
      {locked ? <p className="guidance">本场规则已锁定，停止后可修改。</p> :
        dirty ? <p className="guidance" role="status">有未保存修改；开始盯播使用上次已保存的配置。</p> : null}
    </section>
  );
}
