import { describe, expect, it } from "vitest";
import { normalizeDouyinLiveUrl } from "../../src/shared/live/douyin";

describe("抖音直播间链接校验", () => {
  it("接受示例房间号并归一到唯一规范形", () => {
    expect(normalizeDouyinLiveUrl("https://live.douyin.com/295178185857")).toEqual({
      ok: true,
      url: "https://live.douyin.com/295178185857",
      roomId: "295178185857",
    });
  });

  it("补协议、去尾斜杠、丢弃 query 与 hash", () => {
    expect(normalizeDouyinLiveUrl("  live.douyin.com/295178185857  ")).toMatchObject({
      ok: true,
      url: "https://live.douyin.com/295178185857",
    });
    expect(normalizeDouyinLiveUrl("https://live.douyin.com/295178185857/?enter_from=web&x=1#top")).toMatchObject({
      ok: true,
      url: "https://live.douyin.com/295178185857",
    });
    expect(normalizeDouyinLiveUrl("http://live.douyin.com/295178185857")).toMatchObject({
      ok: true,
      url: "https://live.douyin.com/295178185857",
    });
  });

  it("拒绝空值、非抖音域名与非数字房间号", () => {
    expect(normalizeDouyinLiveUrl("")).toMatchObject({ ok: false });
    expect(normalizeDouyinLiveUrl("https://www.douyin.com/295178185857")).toMatchObject({ ok: false });
    expect(normalizeDouyinLiveUrl("https://live.douyin.com.evil.com/295178185857")).toMatchObject({ ok: false });
    expect(normalizeDouyinLiveUrl("https://live.douyin.com/abc")).toMatchObject({ ok: false });
    expect(normalizeDouyinLiveUrl("https://live.douyin.com/")).toMatchObject({ ok: false });
    expect(normalizeDouyinLiveUrl("https://live.douyin.com/295178185857/extra")).toMatchObject({ ok: false });
    expect(normalizeDouyinLiveUrl("not a url")).toMatchObject({ ok: false });
  });

  it("拒绝非 http(s) 协议", () => {
    expect(normalizeDouyinLiveUrl("javascript:alert(1)")).toMatchObject({ ok: false });
    expect(normalizeDouyinLiveUrl("file:///etc/passwd")).toMatchObject({ ok: false });
  });
});
