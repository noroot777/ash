// 卡片上「在 ash 中打开」实际用的地址前缀。
//
// 设置里填的多半是 Tailscale 的 MagicDNS 名（http://mac.tailnet.ts.net:4317）。这个名字只有 Tailscale 自己的
// 解析器（100.100.100.100）认得，公网 DNS 一律 NXDOMAIN；而飞书的内置浏览器不走系统解析器，手机上点开就是
// 「未能找到使用指定主机名的服务器（-1003）」—— 连接根本没发起，WireGuard 那头一次握手都没有（2026-11-10 实测）。
// 所以 http 的地址在这台机器上解析一次：落在 Tailscale 网段（100.64.0.0/10）的就换成 IP，手机只要连着
// Tailscale 就打得开，不再依赖谁来解析这个名字。https 不换：证书绑的是名字，换成 IP 握手过不去。
// 解析不出来（这台机器的 Tailscale 没开）就照原样用，下一次再试。
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { readOptions } from "./meta.js";

const TTL_MS = 10 * 60_000;
const LOOKUP_TIMEOUT_MS = 2_000;

let cache: { configured: string; base: string; at: number } | null = null;

/** 100.64.0.0/10：Tailscale 给每台设备分的地址都在这一段。 */
export function isTailscaleV4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 100 && b! >= 64 && b! <= 127;
}

/** 配置的前缀 → 卡片上用的前缀。lookupV4 可注入（测试）；解析不出返回 null。 */
export async function resolveLinkBase(
  configured: string | null,
  lookupV4: (host: string) => Promise<string | null> = systemLookup,
): Promise<string | null> {
  if (!configured) return null;
  let url: URL;
  try { url = new URL(configured); } catch { return configured; }
  if (url.protocol !== "http:" || isIP(url.hostname)) return configured;
  if (cache?.configured === configured && Date.now() - cache.at < TTL_MS) return cache.base;
  const address = await lookupV4(url.hostname).catch(() => null);
  if (!address) return cache?.configured === configured ? cache.base : configured;
  url.hostname = isTailscaleV4(address) ? address : url.hostname;
  const base = url.toString().replace(/\/+$/, "");
  cache = { configured, base, at: Date.now() };
  return base;
}

/** 此刻卡片该用的深链前缀（没配就是 null）。 */
export async function cardLinkBase(): Promise<string | null> {
  const configured = await readOptions().then((options) => options.publicBaseUrl, () => null);
  return resolveLinkBase(configured);
}

async function systemLookup(host: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS); });
  try {
    return await Promise.race([lookup(host, { family: 4 }).then((result) => result.address), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 测试换配置后清缓存用。 */
export function resetLinkBaseCache(): void {
  cache = null;
}
