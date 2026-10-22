import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ActionConfig, ActionConfigState, ActionHistory, ActionSignal } from "@shared/contracts/actions";
import { defaultActionConfig } from "@shared/contracts/actions";
import type { FrameworkLoadResult } from "@shared/contracts/framework";
import { isReplaySessionId } from "@shared/contracts/replay";
import { redactReplayValue } from "../security/redact";
import { actionSignalSchema, parseActionConfig } from "./schema";

export class ActionStorage {
  constructor(private readonly root: () => string) {}
  loadConfig(framework: FrameworkLoadResult): ActionConfigState {
    const fallback = defaultActionConfig(
      framework.ok ? framework.revision : "unavailable",
      framework.ok ? framework.document.stages : undefined,
    );
    try {
      const file = path.join(this.root(), "action-rules.v1.json");
      if (!existsSync(file)) return { config: fallback, warning: null };
      if (statSync(file).size > 1_048_576) throw new Error("too large");
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      const parsed = parseActionConfig(raw, framework);
      if (!parsed) return { config: fallback, warning: "动作规则与当前框架不匹配或已损坏；提醒已关闭，请重新检查并保存。" };
      return { config: parsed, warning: null };
    } catch {
      return { config: fallback, warning: "动作规则读取失败；提醒已关闭，请重新检查并保存。" };
    }
  }
  saveConfig(config: ActionConfig): void {
    const root = this.root();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, "action-rules.v1.json");
    writeFileSync(`${file}.tmp`, JSON.stringify(config, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  private file(sessionId: string): string {
    if (!isReplaySessionId(sessionId)) throw new Error("invalid session");
    return path.join(this.root(), "sessions", sessionId, "action-signals.v1.jsonl");
  }
  append(signal: ActionSignal): void {
    const file = this.file(signal.sessionId);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, JSON.stringify({
      schemaVersion: 1, sessionId: signal.sessionId, signal: redactReplayValue(signal),
    }) + "\n", { encoding: "utf8", mode: 0o600 });
  }
  history(sessionId: string): ActionHistory {
    try {
      const file = this.file(sessionId);
      if (!existsSync(file)) return { signals: [], warning: null };
      if (statSync(file).size > 16 * 1024 * 1024) throw new Error("too large");
      const lines = readFileSync(file, "utf8").split("\n").filter(line => line.trim());
      if (lines.length > 20_000) throw new Error("too many events");
      const signals = new Map<string, ActionSignal>();
      const schema = z.object({ schemaVersion: z.literal(1), sessionId: z.literal(sessionId), signal: actionSignalSchema }).strict();
      for (const line of lines) {
        const event = schema.parse(JSON.parse(line));
        if (event.signal.sessionId !== sessionId) throw new Error("wrong session");
        signals.set(event.signal.id, event.signal);
      }
      return { signals: [...signals.values()], warning: null };
    } catch {
      return { signals: [], warning: "信号记录无法读取或已损坏；原有字幕和问题回看不受影响。" };
    }
  }
}
