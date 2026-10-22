const SENSITIVE_KEY = /token|secret|password|authorization|samples|pcm/i;
const SECRET_KEY = /(^|_)(api)?key$/i;

const sensitiveValues = new Set<string>();

export function noteSensitive(value: string): void {
  const trimmed = value.trim();
  if (trimmed.length < 4) return;
  sensitiveValues.add(trimmed);
}

export function resetSensitiveValues(): void {
  sensitiveValues.clear();
}

export function redactText(input: string): string {
  let out = input;
  for (const secret of sensitiveValues) {
    if (out.includes(secret)) out = out.split(secret).join("[redacted]");
  }
  return out;
}

export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(key) || SECRET_KEY.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (key === "text" && typeof value === "string") {
      out[key] = `[len:${value.length}]`;
      continue;
    }
    out[key] = redactValue(value);
  }
  return out;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") return redactFields(value as Record<string, unknown>);
  return value;
}

/** 复盘文件保留转写原文，只抹掉已知密钥和密钥字段。 */
export function redactReplayValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactReplayValue(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key) || SECRET_KEY.test(key)) out[key] = "[redacted]";
      else out[key] = redactReplayValue(inner);
    }
    return out;
  }
  return value;
}
