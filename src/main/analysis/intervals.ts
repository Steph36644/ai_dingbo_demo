export type Interval = { startMs: number; endMs: number };

export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list.filter((item) => item.endMs > item.startMs).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: Interval[] = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && item.startMs <= last.endMs) last.endMs = Math.max(last.endMs, item.endMs);
    else merged.push({ startMs: item.startMs, endMs: item.endMs });
  }
  return merged;
}

export function intervalDuration(list: readonly Interval[]): number {
  return mergeIntervals(list).reduce((total, item) => total + (item.endMs - item.startMs), 0);
}

export function subtractIntervals(base: readonly Interval[], cut: readonly Interval[]): Interval[] {
  let pieces = mergeIntervals(base);
  for (const gap of mergeIntervals(cut)) {
    const next: Interval[] = [];
    for (const piece of pieces) {
      if (gap.endMs <= piece.startMs || gap.startMs >= piece.endMs) {
        next.push(piece);
        continue;
      }
      if (gap.startMs > piece.startMs) next.push({ startMs: piece.startMs, endMs: gap.startMs });
      if (gap.endMs < piece.endMs) next.push({ startMs: gap.endMs, endMs: piece.endMs });
    }
    pieces = next;
  }
  return pieces;
}

export function intersectIntervals(left: readonly Interval[], right: readonly Interval[]): Interval[] {
  const a = mergeIntervals(left);
  const b = mergeIntervals(right);
  const out: Interval[] = [];
  let index = 0;
  for (const item of a) {
    while (index < b.length && b[index]!.endMs <= item.startMs) index += 1;
    let cursor = index;
    while (cursor < b.length && b[cursor]!.startMs < item.endMs) {
      const startMs = Math.max(item.startMs, b[cursor]!.startMs);
      const endMs = Math.min(item.endMs, b[cursor]!.endMs);
      if (endMs > startMs) out.push({ startMs, endMs });
      cursor += 1;
    }
  }
  return out;
}
