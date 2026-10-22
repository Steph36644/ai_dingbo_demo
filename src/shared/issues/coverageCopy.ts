export const COVERAGE_DISTINCTION =
  "本场累计：勾上表示这场里曾经讲到。问题列表里的「近窗漏讲」只看最近的分析窗口，要连续两个完整窗口都没覆盖才会出现。";

export type CoverageEmptyKind = "loading" | "invalid" | "no-must-say" | "not-started";

export function coverageEmptyKind(input: {
  frameworkReady: boolean | null;
  mustSayCount: number;
  itemCount: number;
}): CoverageEmptyKind | null {
  if (input.itemCount > 0) return null;
  if (input.frameworkReady == null) return "loading";
  if (!input.frameworkReady) return "invalid";
  if (input.mustSayCount === 0) return "no-must-say";
  return "not-started";
}

export function coverageEmptyMessage(kind: CoverageEmptyKind): string {
  switch (kind) {
    case "loading":
      return "正在读取话术框架。本场累计勾选和近窗漏讲都会等框架就绪。";
    case "invalid":
      return "框架还没通过校验，本场累计勾选不会开始。这和近窗漏讲不是一回事。";
    case "no-must-say":
      return "这份框架没有必讲点（must_say）。近窗漏讲问题也不会出现。";
    case "not-started":
      return "还没开始本场。开始后这里按整场累计勾选；近窗漏讲在问题列表里，不会占用这些勾选。";
  }
}
