import fs from "node:fs";
import path from "node:path";
import type { FrameworkLoadResult } from "@shared/contracts/framework";
import { frameworkRevision, validateFramework } from "./schema";

const MAX_BYTES = 1_048_576;

export function defaultFrameworkPath(): string {
  return path.join(process.cwd(), "frameworks", "example-framework.v0.json");
}

/** 启动时校验本地 JSON。失败结果留在 store 里，开始盯播会被拒绝。 */
export class FrameworkStore {
  private result: FrameworkLoadResult = {
    ok: false,
    code: "io_error",
    message: "还没有加载话术框架。开始盯播前需要一份通过校验的 JSON。",
  };

  current(): FrameworkLoadResult {
    return this.result;
  }

  loadFirstAvailable(paths: readonly string[]): FrameworkLoadResult {
    let last = this.current();
    for (const filePath of paths) {
      last = this.loadFile(filePath);
      if (last.ok) return last;
    }
    return last;
  }

  loadFile(filePath: string): FrameworkLoadResult {
    const resolved = path.resolve(filePath);
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        return this.failIo(resolved, "路径不是文件");
      }
      if (stat.size > MAX_BYTES) {
        return this.failIo(resolved, "文件超过 1MB");
      }
      const text = fs.readFileSync(resolved, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        return this.failIo(resolved, "不是合法 JSON");
      }
      return this.loadObject(parsed, resolved);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "读取失败";
      return this.failIo(resolved, reason);
    }
  }

  loadObject(value: unknown, sourcePath: string | null = null): FrameworkLoadResult {
    const validated = validateFramework(value);
    if (!validated.ok) {
      this.result = { ...validated, sourcePath: sourcePath ?? undefined };
      return this.result;
    }
    this.result = {
      ok: true,
      revision: frameworkRevision(validated.document),
      sourcePath,
      document: validated.document,
    };
    return this.result;
  }

  private failIo(sourcePath: string, reason: string): FrameworkLoadResult {
    this.result = {
      ok: false,
      code: "io_error",
      message: `读不了话术框架：${sourcePath}。${reason}`,
      sourcePath,
    };
    return this.result;
  }
}
