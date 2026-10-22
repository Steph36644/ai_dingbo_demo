import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const RENDERER_DIR = path.resolve(__dirname, "../../src/renderer");
const TOKENS_FILE = path.join(RENDERER_DIR, "app/tokens.css");

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...cssFiles(full));
    else if (name.endsWith(".css")) out.push(full);
  }
  return out;
}

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

describe("设计 token 单一来源", () => {
  it("tokens.css 覆盖 v1.0.0 必需 token", () => {
    const source = readFileSync(TOKENS_FILE, "utf8");
    const required = [
      "--bg-0", "--bg-1", "--bg-2", "--bg-3", "--border-0",
      "--text-0", "--text-1", "--text-2",
      "--accent", "--ok", "--warn", "--crit",
      "--stage-bg", "--stage-ink",
      "--space-1", "--space-6", "--text-xs", "--text-2xl",
      "--row-h", "--topbar-h", "--statusbar-h",
      "--dock-left-w", "--dock-right-w", "--radius-panel", "--radius-control", "--radius-pill",
    ];
    for (const token of required) expect(source).toContain(`${token}:`);
  });

  it("除 tokens.css 外，渲染层 CSS 不出现颜色字面量", () => {
    const offenders: string[] = [];
    for (const file of cssFiles(RENDERER_DIR)) {
      if (file === TOKENS_FILE) continue;
      const source = readFileSync(file, "utf8");
      source.split(/\r?\n/).forEach((line, index) => {
        if (COLOR_LITERAL.test(line)) offenders.push(`${path.relative(RENDERER_DIR, file)}:${index + 1} ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("tokens.css 的颜色 token 只有十六进制值", () => {
    const source = readFileSync(TOKENS_FILE, "utf8");
    const colorTokens = new Set([
      "--bg-0", "--bg-1", "--bg-2", "--bg-3", "--border-0",
      "--text-0", "--text-1", "--text-2",
      "--accent", "--ok", "--warn", "--crit",
      "--stage-bg", "--stage-ink",
    ]);
    const colors = source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => colorTokens.has(line.slice(0, line.indexOf(":"))));
    expect(colors).toHaveLength(colorTokens.size);
    for (const line of colors) expect(line).toMatch(/^--[a-z0-9-]+:\s*#[0-9a-fA-F]{6};$/);
  });
});
