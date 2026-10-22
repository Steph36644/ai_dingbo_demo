import { useCallback, useEffect, useLayoutEffect, useRef, type TouchEvent, type UIEvent, type WheelEvent } from "react";
import { captionFollowAfterScroll, distanceFromBottom, isNearBottom, shouldPinCaptions } from "./captionsFollow";

const GESTURE_SETTLE_MS = 150;
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * 盯播时把实时字幕容器贴在最新一句。
 * 用户上翻或拖动查看历史时暂停，回到底部附近再继续跟随。
 */
export function useCaptionFollow(liveKey: string, resetFollow: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const follow = useRef(true);
  const programmatic = useRef(false);
  const wheelLeaving = useRef(false);
  const pointerHolding = useRef(false);
  const pinGeneration = useRef(0);
  const settleTimer = useRef<number | null>(null);
  const touchY = useRef<number | null>(null);
  const pointerEnd = useRef<(() => void) | null>(null);

  const userLeaving = useCallback(() => wheelLeaving.current || pointerHolding.current, []);

  const pinToLatest = useCallback(() => {
    const stage = ref.current;
    if (!stage || !shouldPinCaptions(follow.current, userLeaving())) return;
    if (distanceFromBottom(stage) <= 1) return;
    const generation = pinGeneration.current + 1;
    pinGeneration.current = generation;
    programmatic.current = true;
    stage.scrollTop = stage.scrollHeight;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (pinGeneration.current === generation) programmatic.current = false;
      });
    });
  }, [userLeaving]);

  const settle = useCallback(() => {
    wheelLeaving.current = false;
    if (pointerHolding.current) return;
    const stage = ref.current;
    if (!stage) return;
    follow.current = isNearBottom(stage);
    pinToLatest();
  }, [pinToLatest]);

  const scheduleSettle = useCallback(() => {
    if (settleTimer.current != null) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      settle();
    }, GESTURE_SETTLE_MS);
  }, [settle]);

  useIsoLayoutEffect(() => {
    if (resetFollow) follow.current = true;
    pinToLatest();
  }, [liveKey, resetFollow, pinToLatest]);

  useEffect(() => {
    const stage = ref.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const list = stage.querySelector(".transcript-document");
    const observer = new ResizeObserver(() => {
      pinToLatest();
    });
    observer.observe(stage);
    if (list) observer.observe(list);
    return () => observer.disconnect();
  }, [pinToLatest]);

  useEffect(() => {
    return () => {
      if (settleTimer.current != null) window.clearTimeout(settleTimer.current);
      pointerEnd.current?.();
    };
  }, []);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    follow.current = captionFollowAfterScroll(follow.current, programmatic.current, isNearBottom(event.currentTarget));
  }, []);

  const onWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (event.deltaY < 0) wheelLeaving.current = true;
      scheduleSettle();
    },
    [scheduleSettle],
  );

  const onTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    touchY.current = event.touches[0]?.clientY ?? null;
  }, []);

  const onTouchMove = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      const y = event.touches[0]?.clientY;
      const previous = touchY.current;
      if (y == null || previous == null) return;
      if (y - previous > 4) wheelLeaving.current = true;
      touchY.current = y;
      scheduleSettle();
    },
    [scheduleSettle],
  );

  const onPointerDown = useCallback(() => {
    if (pointerEnd.current) {
      window.removeEventListener("pointerup", pointerEnd.current);
      window.removeEventListener("pointercancel", pointerEnd.current);
      pointerEnd.current = null;
    }
    pointerHolding.current = true;
    const end = () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (pointerEnd.current === end) pointerEnd.current = null;
      pointerHolding.current = false;
      settle();
    };
    pointerEnd.current = end;
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }, [settle]);

  return { ref, onScroll, onWheel, onTouchStart, onTouchMove, onPointerDown };
}
