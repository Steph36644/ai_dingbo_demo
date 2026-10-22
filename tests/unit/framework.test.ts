import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FrameworkStore } from "../../src/main/framework/FrameworkStore";
import { canonicalJson, frameworkRevision, validateFramework } from "../../src/main/framework/schema";

const examplePath = path.join(process.cwd(), "frameworks", "example-framework.v0.json");
const richPath = path.join(process.cwd(), "frameworks", "example-framework.v0.1-rich.json");

describe("话术框架", () => {
  it("能加载示例文件，revision 不随键顺序变化", () => {
    const store = new FrameworkStore();
    const loaded = store.loadFile(examplePath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.document.title).toContain("示例");
    expect(loaded.document.must_say).toHaveLength(3);
    expect(loaded.revision).toMatch(/^[a-f0-9]{64}$/);

    const raw = JSON.parse(fs.readFileSync(examplePath, "utf8")) as Record<string, unknown>;
    const reordered = {
      title: raw.title,
      avoid: raw.avoid,
      stages: raw.stages,
      must_say: raw.must_say,
      pace: raw.pace,
      id: raw.id,
    };
    const first = validateFramework(raw);
    const second = validateFramework(reordered);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(frameworkRevision(first.document)).toBe(frameworkRevision(second.document));
    expect(frameworkRevision(first.document)).toBe(loaded.revision);
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("坏字段会指出 JSON 路径，并且不接受空关键词、重复 id 和未知字段", () => {
    const pace = { min: 180, max: 280, unit: "chars_per_minute" as const };
    const item = { id: "ms-1", text: "价格", keywords: ["活动价"] };
    const base = { pace, must_say: [item], avoid: [{ id: "av-1", text: "疗效", keywords: ["一定能"] }] };

    const swapped = validateFramework({ ...base, pace: { ...pace, min: 300, max: 100 } });
    expect(swapped.ok).toBe(false);
    if (!swapped.ok) {
      expect(swapped.jsonPath).toBe("pace.min");
      expect(swapped.message).toContain("pace.min");
    }

    const blank = validateFramework({ ...base, must_say: [{ ...item, keywords: ["   "] }] });
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.jsonPath).toContain("keywords");

    const punctuation = validateFramework({ ...base, avoid: [{ id: "av-1", text: "疗效", keywords: ["，"] }] });
    expect(punctuation.ok).toBe(false);
    if (!punctuation.ok) expect(punctuation.message).toContain("规范化后是空的");

    const duplicate = validateFramework({
      ...base,
      avoid: [{ id: "ms-1", text: "冲突", keywords: ["根治"] }],
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.message).toContain("重复");

    const extra = validateFramework({ ...base, extra: true });
    expect(extra.ok).toBe(false);

    const unit = validateFramework({ ...base, pace: { min: 1, max: 2, unit: "wpm" } });
    expect(unit.ok).toBe(false);
    if (!unit.ok) expect(unit.jsonPath).toBe("pace.unit");
  });

  it("丰富版样例能与 v0 并存，并保住动作提醒用的 id", () => {
    const store = new FrameworkStore();
    const loaded = store.loadFile(richPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.document.id).toBe("demo-sku-001-rich");
    expect(loaded.document.title).toContain("丰富版");
    expect(loaded.document.must_say.map((item) => item.id)).toEqual(
      expect.arrayContaining(["ms-1", "ms-2", "ms-3"]),
    );
    expect(loaded.document.stages?.map((stage) => stage.id)).toEqual(
      expect.arrayContaining(["warmup", "pitch", "close"]),
    );
    expect(loaded.document.must_say.length).toBeGreaterThan(3);
    expect(loaded.document.stages?.length).toBeGreaterThan(3);

    const original = new FrameworkStore().loadFile(examplePath);
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    expect(original.document.id).toBe("demo-sku-001");
    expect(original.document.must_say).toHaveLength(3);
  });

  it("读不到文件时保留失败结果", () => {
    const store = new FrameworkStore();
    const missing = store.loadFile(path.join(process.cwd(), "frameworks", "missing.json"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("io_error");
    expect(store.current()).toEqual(missing);
  });
});
