import { z } from "zod";
import type { FrameworkLoadResult } from "@shared/contracts/framework";
import type { ActionConfig } from "@shared/contracts/actions";

const id = z.string().min(1).max(200);
const kind = z.enum(["stream.push_suggested", "coupon.issue_suggested"]);
export const actionConfigSchema = z.object({
  schemaVersion: z.literal(1), enabled: z.boolean(), frameworkRevision: id,
  rules: z.array(z.object({
    id, kind, enabled: z.boolean(), stageId: id.nullable(),
    stageIds: z.array(id).max(20).optional(),
    requiredItemIds: z.array(id).max(200),
    cooldownSeconds: z.number().int().min(30).max(3600),
  }).strict()).max(20),
}).strict();

export function parseActionConfig(raw: unknown, framework: FrameworkLoadResult): ActionConfig | null {
  const parsed = actionConfigSchema.safeParse(raw);
  if (!parsed.success || !framework.ok) return null;
  const config = parsed.data;
  // revision 是整份框架文档的哈希，改标题或加关键词都会变；规则本身只依赖 stage / must_say 的 id，
  // 所以只要 id 仍能解析，就把旧配置迁移到当前 revision，而不是整体判废。
  if (new Set(config.rules.map(r => r.id)).size !== config.rules.length) return null;
  if (config.enabled && !config.rules.some(r => r.enabled)) return null;
  const items = new Set(framework.document.must_say.map(i => i.id));
  const stages = new Set(framework.document.stages?.map(s => s.id));
  for (const rule of config.rules) {
    if (rule.stageIds && new Set(rule.stageIds).size !== rule.stageIds.length) return null;
    if (!rule.enabled) continue;
    if (new Set(rule.requiredItemIds).size !== rule.requiredItemIds.length ||
      rule.requiredItemIds.some(i => !items.has(i))) return null;
    const stageIds = rule.stageIds ?? [];
    if (!stages.size) {
      if (rule.stageId !== null || stageIds.length > 0) return null;
      continue;
    }
    if (rule.stageId !== null && !stages.has(rule.stageId)) return null;
    if (stageIds.some(stage => !stages.has(stage))) return null;
  }
  return { ...config, frameworkRevision: framework.revision };
}

export const resolveActionSchema = z.object({
  sessionId: z.string().uuid(), signalId: z.string().uuid(),
  status: z.enum(["acknowledged", "dismissed"]),
}).strict();

export const actionSignalSchema = z.object({
  id: z.string().uuid(), sessionId: z.string().uuid(), ruleId: id, kind,
  emittedAtMs: z.number().finite().nonnegative(), frameworkRevision: id,
  stageId: id.nullable(), stageLabel: z.string().max(1000),
  delivery: z.literal("control_only"),
  status: z.enum(["pending", "acknowledged", "dismissed", "expired"]),
  handledAtMs: z.number().finite().nonnegative().nullable(),
  reason: z.string().max(1000).nullable(),
  evidence: z.object({
    windowStartMs: z.number().finite().nonnegative(), windowEndMs: z.number().finite().nonnegative(),
    items: z.array(z.object({ id, text: z.string(), segmentIds: z.array(z.string()).max(1000) })).max(200),
    excerpts: z.array(z.object({
      segmentId: z.string(), text: z.string(), startMs: z.number().finite(), endMs: z.number().finite(),
    })).max(200),
    noAvoidHit: z.boolean(),
  }),
}).strict();
