import { redactFields } from "./redact";

export function logEvent(
  level: "info" | "warn" | "error",
  module: string,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    module,
    event,
    ...redactFields(fields),
  };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
