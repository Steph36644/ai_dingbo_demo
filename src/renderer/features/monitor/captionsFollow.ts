/** 距底部小于等于该值时，认为用户还在看最新一句。 */
export const CAPTIONS_FOLLOW_THRESHOLD_PX = 48;

export type ScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

export function distanceFromBottom(metrics: ScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
}

export function isNearBottom(metrics: ScrollMetrics, threshold = CAPTIONS_FOLLOW_THRESHOLD_PX): boolean {
  return distanceFromBottom(metrics) <= threshold;
}

/**
 * 程序化贴底也会触发 scroll。字幕变高后若拿这次事件去判断，
 * 会把「还没贴到底」误当成用户上翻，跟随就被永久关掉。
 */
export function captionFollowAfterScroll(following: boolean, programmatic: boolean, nearBottom: boolean): boolean {
  if (programmatic) return following;
  return nearBottom;
}

/** 用户正在上翻或拖动历史时，不要把视口拉回底部。 */
export function shouldPinCaptions(following: boolean, userLeaving: boolean): boolean {
  return following && !userLeaving;
}
