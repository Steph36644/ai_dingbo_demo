import { randomUUID } from "node:crypto";
import type {
  ActionConfig, ActionConfigState, ActionResolveRequest, ActionResult, ActionRule, ActionSignal, ActionsSnapshot,
} from "@shared/contracts/actions";
import type { FrameworkLoadResult } from "@shared/contracts/framework";
import type { CoverageItem } from "@shared/contracts/issue";
import type { TranscriptSegment } from "@shared/contracts/transcript";
import { matchActionCue } from "./cues";
import { ActionStorage } from "./storage";
import { parseActionConfig } from "./schema";

export type ActionObservation = {
  sessionId: string; running: boolean; complete: boolean; finalFlush: boolean; qualityOk: boolean;
  stageId: string | null; stageLabel: string; windowStartMs: number; windowEndMs: number;
  coverage: CoverageItem[]; segments: readonly TranscriptSegment[]; avoidHit: boolean;
};

/** Consumes Main analysis results; no ASR, scheduler or network of its own. */
export class ActionSignals {
  private sessionId: string | null = null;
  private config: ActionConfig | null = null;
  private signals: ActionSignal[] = [];
  private warning: string | null = null;
  private truth = new Map<string, boolean>();
  private lastEmitted = new Map<string, number>();
  private firedFamilies = new Map<string, Set<string>>();
  private lastWindowEnd = -1;
  private listeners = new Set<(snapshot: ActionsSnapshot) => void>();
  constructor(readonly storage: ActionStorage, private readonly now = Date.now) {}
  getConfig(framework: FrameworkLoadResult): ActionConfigState { return this.storage.loadConfig(framework); }
  saveConfig(raw: unknown, framework: FrameworkLoadResult): ActionResult {
    const config = parseActionConfig(raw, framework);
    if (!config) return { ok: false, message: "规则无效：阶段须属于当前框架，讲点须来自当前框架，冷却须为 30–3600 秒。" };
    try { this.storage.saveConfig(config); }
    catch { return { ok: false, message: "动作规则保存失败，原配置保持不变。" }; }
    if (!config.enabled) {
      if (this.config) this.config.enabled = false;
      this.invalidate("动作提醒已关闭");
    }
    return { ok: true };
  }
  begin(sessionId: string, framework: FrameworkLoadResult): void {
    const state = this.getConfig(framework);
    this.sessionId = sessionId; this.config = state.config; this.warning = state.warning;
    this.signals = []; this.truth.clear(); this.lastEmitted.clear(); this.firedFamilies.clear(); this.lastWindowEnd = -1;
    this.emit();
  }
  snapshot(): ActionsSnapshot {
    return structuredClone({
      sessionId: this.sessionId, enabled: this.config?.enabled ?? false,
      signals: this.signals, warning: this.warning,
    });
  }
  onChange(listener: (snapshot: ActionsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  invalidate(reason: string): void {
    let changed = false;
    for (const signal of this.signals) {
      if (signal.status !== "pending") continue;
      this.expire(signal, reason); changed = true;
    }
    this.truth.clear();
    if (changed) this.emit();
  }
  observe(input: ActionObservation): void {
    if (input.sessionId !== this.sessionId) return;
    if (!input.running || input.finalFlush || !input.complete || !input.qualityOk) {
      this.lastWindowEnd = Math.max(this.lastWindowEnd, input.windowEndMs);
      this.invalidate("会话或分析窗口质量不满足提醒条件"); return;
    }
    if (!this.config?.enabled || input.windowEndMs <= this.lastWindowEnd) return;
    this.lastWindowEnd = input.windowEndMs;
    const covered = new Map(input.coverage.filter(i => i.covered).map(i => [i.frameworkItemId, i]));
    const windowSegments = input.segments.filter(segment => segment.endMs > input.windowStartMs && segment.startMs < input.windowEndMs);
    let changed = false;
    for (const rule of this.config.rules) {
      if (!rule.enabled) continue;
      const cue = matchActionCue(rule.kind, windowSegments);
      const coverageOk = rule.requiredItemIds.length > 0 && rule.requiredItemIds.every(id => covered.has(id));
      const matches = stageAllows(rule, input.stageId)
        && (rule.kind !== "coupon.issue_suggested" || !input.avoidHit)
        && (cue.hit || coverageOk);
      const wasTrue = this.truth.get(rule.id) ?? false;
      this.truth.set(rule.id, matches);
      if (!matches) {
        for (const signal of this.signals.filter(s => s.ruleId === rule.id && s.status === "pending")) {
          this.expire(signal, "触发条件已失效"); changed = true;
        }
        continue;
      }
      const fired = this.firedFamilies.get(rule.id) ?? new Set<string>();
      const novel = cue.families.some(family => !fired.has(family));
      const cooling = input.windowEndMs - (this.lastEmitted.get(rule.id) ?? -Infinity) < rule.cooldownSeconds * 1000;
      const pending = this.signals.some(s => s.ruleId === rule.id && s.status === "pending");
      // 硬冷却：新说法也不能提前再响。冷却结束后，条件重新变成真，或出现没报过的说法，才再响。
      // 同一种说法一直停在窗口里，冷却到点也不补弹。
      if (cooling || (!novel && (wasTrue || pending))) continue;
      if (this.signals.length >= 5000) {
        this.warning = "本场提醒数量达到上限，已暂停新增提醒；请结束本场后重新开始。";
        changed = true; continue;
      }
      const items = [
        ...rule.requiredItemIds.filter(id => covered.has(id)).map(id => ({
          id, text: covered.get(id)!.text, segmentIds: [...covered.get(id)!.matchedSegmentIds],
        })),
        ...(cue.hit ? cue.families.map((family, index) => ({
          id: family, text: cue.labels[index] ?? family, segmentIds: cue.segmentIds,
        })) : []),
      ];
      const segmentIds = new Set(items.flatMap(i => i.segmentIds));
      const signal: ActionSignal = {
        id: randomUUID(), sessionId: input.sessionId, ruleId: rule.id, kind: rule.kind,
        emittedAtMs: this.now(), frameworkRevision: this.config.frameworkRevision,
        stageId: input.stageId, stageLabel: input.stageLabel, delivery: "control_only",
        status: "pending", handledAtMs: null, reason: null,
        evidence: {
          windowStartMs: input.windowStartMs, windowEndMs: input.windowEndMs, items, noAvoidHit: !input.avoidHit,
          excerpts: input.segments.filter(s => segmentIds.has(s.id)).slice(-200).map(s => ({
            segmentId: s.id, text: s.text, startMs: s.startMs, endMs: s.endMs,
          })),
        },
      };
      this.signals.push(signal);
      this.lastEmitted.set(rule.id, input.windowEndMs);
      this.firedFamilies.set(rule.id, new Set(cue.families));
      this.record(signal); changed = true;
    }
    if (changed) this.emit();
  }
  resolve(request: ActionResolveRequest, running: boolean): ActionResult {
    if (request.sessionId !== this.sessionId) return { ok: false, message: "该提醒不属于当前场次。" };
    const signal = this.signals.find(s => s.id === request.signalId);
    if (!signal || !running || signal.status === "expired") return { ok: false, message: "提醒已失效或本场已停止。" };
    if (signal.status === request.status) return { ok: true };
    if (signal.status !== "pending") return { ok: false, message: "提醒已经处理，不能重复更改。" };
    signal.status = request.status; signal.handledAtMs = this.now();
    this.record(signal); this.emit();
    return { ok: true };
  }
  private expire(signal: ActionSignal, reason: string): void {
    signal.status = "expired"; signal.handledAtMs = this.now(); signal.reason = reason;
    this.record(signal);
  }
  private record(signal: ActionSignal): void {
    try { this.storage.append(signal); }
    catch { this.warning = "信号记录写入失败；本场记录仍在内存中，关闭后可能丢失。盯播继续。"; }
  }
  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function stageAllows(rule: ActionRule, stageId: string | null): boolean {
  const selected = rule.stageIds?.length ? rule.stageIds : rule.stageId ? [rule.stageId] : [];
  if (selected.length === 0) return true;
  return stageId !== null && selected.includes(stageId);
}
