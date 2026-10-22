import { createHash } from "node:crypto";
import { z } from "zod";
import type { FrameworkDocument, FrameworkLoadResult } from "@shared/contracts/framework";
import { normalizeText } from "../transcript/normalize";

const keywordSchema = z.string().trim().min(1, "关键词不能为空");

const itemSchema = z
  .object({
    id: z.string().trim().min(1, "不能为空"),
    text: z.string().trim().min(1, "不能为空"),
    keywords: z.array(keywordSchema).min(1, "至少要有一个关键词"),
  })
  .strict();

const stageSchema = z
  .object({
    id: z.string().trim().min(1, "不能为空"),
    name: z.string().trim().min(1, "不能为空"),
    hint: z.string().optional(),
  })
  .strict();

const frameworkSchema = z
  .object({
    id: z.string().trim().min(1, "不能为空").optional(),
    title: z.string().trim().min(1, "不能为空").optional(),
    pace: z
      .object({
        min: z.number().finite("必须是有限数字").positive("必须是正数"),
        max: z.number().finite("必须是有限数字").positive("必须是正数"),
        unit: z.literal("chars_per_minute", { errorMap: () => ({ message: "只能是 chars_per_minute" }) }),
        note: z.string().optional(),
      })
      .strict()
      .refine((pace) => pace.min <= pace.max, { message: "min 不能大于 max", path: ["min"] }),
    must_say: z.array(itemSchema),
    avoid: z.array(itemSchema),
    stages: z.array(stageSchema).optional(),
  })
  .strict();

export type FrameworkValidation =
  | { ok: true; document: FrameworkDocument }
  | Pick<Extract<FrameworkLoadResult, { ok: false }>, "ok" | "code" | "message" | "jsonPath">;

export function validateFramework(input: unknown): FrameworkValidation {
  const parsed = frameworkSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const jsonPath = issue && issue.path.length > 0 ? issue.path.join(".") : "(root)";
    const detail = issue?.message ?? "校验失败";
    return {
      ok: false,
      code: "invalid_framework",
      jsonPath,
      message: `话术框架无效（${jsonPath}）：${detail}`,
    };
  }
  const document = parsed.data;
  const seen = new Set<string>();
  const entries = [
    ...document.must_say.map((item) => ({ path: "must_say", item })),
    ...document.avoid.map((item) => ({ path: "avoid", item })),
    ...(document.stages ?? []).map((item) => ({ path: "stages", item })),
  ];
  for (const entry of entries) {
    if (seen.has(entry.item.id)) {
      return {
        ok: false,
        code: "invalid_framework",
        jsonPath: entry.path,
        message: `话术框架无效（${entry.path}）：id「${entry.item.id}」重复`,
      };
    }
    seen.add(entry.item.id);
  }
  for (const group of ["must_say", "avoid"] as const) {
    for (const [index, item] of document[group].entries()) {
      for (const [keywordIndex, keyword] of item.keywords.entries()) {
        if (normalizeText(keyword).length === 0) {
          const jsonPath = `${group}.${index}.keywords.${keywordIndex}`;
          return {
            ok: false,
            code: "invalid_framework",
            jsonPath,
            message: `话术框架无效（${jsonPath}）：关键词规范化后是空的`,
          };
        }
      }
    }
  }
  return { ok: true, document };
}

/** 规范化 JSON：对象键排序，数组保序，跳过 undefined。用于 revision，不看原文排版。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function frameworkRevision(document: FrameworkDocument): string {
  return createHash("sha256").update(canonicalJson(document)).digest("hex");
}
