import type { PunctuationOverlay } from "@shared/contracts/transcript";

/**
 * 标点覆盖只属于刚停的本场（`replay:loadCurrent`，没有钉住目录场次）。
 * `pinnedSessionId` 有值表示经由 `replay:loadBySessionId` 打开：无论是不是当前 sessionId，都不套这份覆盖。
 */
export function presentationForReplay(
  pinnedSessionId: string | null,
  currentSessionId: string | null | undefined,
  presentation: PunctuationOverlay | null,
): PunctuationOverlay | null {
  const openedFromCatalog = pinnedSessionId != null;
  const otherSession = openedFromCatalog && pinnedSessionId !== (currentSessionId ?? null);
  if (openedFromCatalog || otherSession) return null;
  return presentation;
}
