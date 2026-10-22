const LIVE_HOST = "live.douyin.com";
const ROOM_PATH = /^\/(\d{6,20})\/?$/;

export type DouyinLiveUrlResult =
  | { ok: true; url: string; roomId: string }
  | { ok: false; message: string };

/**
 * 只接受 live.douyin.com 的数字房间号链接。渲染进程与主进程共用，
 * 返回值是唯一规范形，避免 query / hash 或协议差异带进隐藏播放窗。
 */
export function normalizeDouyinLiveUrl(raw: string): DouyinLiveUrlResult {
  const text = raw.trim();
  if (!text) return { ok: false, message: "请先粘贴抖音直播间链接。" };
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`;

  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    return { ok: false, message: "链接格式不正确，请粘贴抖音直播间链接。" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, message: "只支持 https 的抖音直播间链接。" };
  }
  if (parsed.hostname.toLowerCase() !== LIVE_HOST) {
    return { ok: false, message: "目前只支持 live.douyin.com 的直播间链接。" };
  }
  const matched = ROOM_PATH.exec(parsed.pathname);
  if (!matched) {
    return { ok: false, message: "直播间链接里没有有效的房间号，示例：https://live.douyin.com/295178185857" };
  }
  const roomId = matched[1];
  return { ok: true, url: `https://${LIVE_HOST}/${roomId}`, roomId };
}
