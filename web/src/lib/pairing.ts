import { localeDate } from "./localeFormat.ts";
// 设备配对在界面上的两处(顶条、设置页的「远程访问」卡)共用的小东西。

/** 一处处理完申请后喊一声,另一处立刻重读,不必等下一轮轮询。 */
export const PAIR_REQUESTS_CHANGED_EVENT = "ash:pair-requests-changed";

export function seenLabel(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const mins = Math.floor((Date.now() - at) / 60_000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days} 天前` : localeDate(at);
}

/**
 * 二维码里的那条地址。机主多半是在 localhost 上点的「添加设备」—— 那个地址手机扫了没用,
 * 得换成这台机器在网卡上的地址(`host`,服务端给的);本来就是从别的设备打开的,当前这个
 * 地址就是通的。
 */
export function pairLink(code: string, host: string | undefined): string | null {
  const { protocol, port, origin } = window.location;
  if (!isLoopbackPage()) return `${origin}/?pair=${encodeURIComponent(code)}`;
  if (!host) return null;
  return `${protocol}//${host}${port ? `:${port}` : ""}/?pair=${encodeURIComponent(code)}`;
}

/** 这个页面是不是在 ash 所在的那台机器上、用回环地址打开的。 */
export function isLoopbackPage(): boolean {
  const { hostname } = window.location;
  return hostname === "localhost" || hostname === "[::1]" || /^127\./.test(hostname);
}
