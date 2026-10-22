import { describe, expect, it } from "vitest";
import {
  CAPTIONS_FOLLOW_THRESHOLD_PX,
  captionFollowAfterScroll,
  distanceFromBottom,
  isNearBottom,
  shouldPinCaptions,
} from "../../src/renderer/features/monitor/captionsFollow";

describe("实时字幕跟随最新", () => {
  it("还在底部附近时继续跟随，离开阈值就不再贴底", () => {
    expect(distanceFromBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 600 })).toBe(0);
    expect(isNearBottom({ scrollHeight: 400, scrollTop: 0, clientHeight: 800 })).toBe(true);
    expect(
      isNearBottom({
        scrollHeight: 1000,
        scrollTop: 400 - CAPTIONS_FOLLOW_THRESHOLD_PX,
        clientHeight: 600,
      }),
    ).toBe(true);
    expect(
      isNearBottom({
        scrollHeight: 1000,
        scrollTop: 400 - CAPTIONS_FOLLOW_THRESHOLD_PX - 1,
        clientHeight: 600,
      }),
    ).toBe(false);
  });

  it("程序化贴底产生的 scroll 不能把跟随关掉", () => {
    expect(captionFollowAfterScroll(true, true, false)).toBe(true);
    expect(captionFollowAfterScroll(false, true, true)).toBe(false);
  });

  it("用户自己滚动时，离开底部就暂停，回到底部再跟随", () => {
    expect(captionFollowAfterScroll(true, false, false)).toBe(false);
    expect(captionFollowAfterScroll(false, false, true)).toBe(true);
  });

  it("用户正在上翻时不要拉回最新一句", () => {
    expect(shouldPinCaptions(true, true)).toBe(false);
    expect(shouldPinCaptions(true, false)).toBe(true);
    expect(shouldPinCaptions(false, false)).toBe(false);
  });
});
