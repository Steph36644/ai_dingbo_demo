import { useEffect, useRef, useState } from "react";
import type { ActionSignal, ActionsSnapshot } from "@shared/contracts/actions";
import type { SessionSnapshot } from "@shared/contracts/session";
import { ActionCards } from "./ActionCards";
import { actionBridge } from "./bridge";

export function LiveActions({ session }: { session: SessionSnapshot | null }) {
  const [snapshot, setSnapshot] = useState<ActionsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = useRef(0);
  useEffect(() => {
    const bridge = actionBridge();
    if (!bridge) return;
    let cancelled = false;
    let pushed = false;
    setError(null); setBusy(false); operation.current++;
    const off = bridge.onActions(value => { pushed = true; setSnapshot(value); });
    void bridge.getActions().then(value => {
      if (!cancelled && !pushed) setSnapshot(value);
    }).catch(() => { if (!cancelled) setError("动作信号读取失败。"); });
    return () => { cancelled = true; operation.current++; off(); };
  }, [session?.sessionId]);

  async function resolve(signal: ActionSignal, status: "acknowledged" | "dismissed") {
    const request = ++operation.current;
    setBusy(true); setError(null);
    try {
      const result = await actionBridge()?.resolveAction({ sessionId: signal.sessionId, signalId: signal.id, status });
      if (request === operation.current && !result?.ok) setError(result?.message ?? "处理失败");
    } catch { if (request === operation.current) setError("处理失败，请重试。"); }
    finally { if (request === operation.current) setBusy(false); }
  }
  const current = snapshot?.sessionId === session?.sessionId ? snapshot : null;
  return <ActionCards signals={current?.signals ?? []} warning={error ?? current?.warning ?? null}
    busy={busy} onResolve={session?.state === "running" ? (signal, status) => void resolve(signal, status) : undefined} />;
}
