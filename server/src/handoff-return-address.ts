// 回程地址解析:一条接入任务(direction === "in")该往哪个 URL 移回。
//
// 三档,从准到糙:
//   1. marker.peerUrl —— 导入那一刻由真实 TCP 来源 + 源机自报监听端口恢复出来的,
//      和这条任务绑定,最准。
//   2. 设置里指纹一致的 handoffTargets —— 用户手工登记过的整机地址,可能是 DHCP
//      换租约前的旧值,只当兜底。
//   3. **探测**:handoff_peers 只留了来源机最近一次来访的 TCP 地址(没有它的监听
//      端口),源机主机名也在 marker 里;把这些 host 和几个已知端口组合出来并行探
//      一遍,指纹对上的那个就是回程地址。
//
// 第 3 档以前是直接返回 null、让用户手填地址的——那正是「明明刚从这台机器接过来,
// 移回却要我填地址」的来源。之所以现在敢自动猜,是因为**猜错连不上,但绝不会猜到
// 别的机器上**:
//   - 探测走 /api/handoff/ping 的**签名挑战**(只读、不带本机签名,也不会把本机塞进
//     对端待批列表):对端得用私钥现签一个 nonce,指纹按它的公钥现算,再和这条任务
//     记录的 peerFp 比对,验不过或对不上一律丢弃。自报指纹的 /handoff/identity 不能
//     用在这里 —— 那种一串明文谁都能复读,占了旧 IP 的无关服务就能把定位骗走;
//   - 即便这一步选错了地址,真正打包前的预检还会用同一份指纹做签名挑战
//     (handoff-peer-client.ts 的 pingPeer,trust === "mismatch" 直接 409),
//     第三台机器过不了这一关,拿不到仓库和会话历史。
import type { HandoffTarget, TaskHandoff } from "@ash/shared";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { eq } from "drizzle-orm";
import { getAppSettings } from "./app-settings.js";
import { db } from "./db/index.js";
import { handoffPeers, tasks } from "./db/schema.js";
import { sameFingerprint } from "./handoff-identity.js";
import { probeSignedPeerFingerprint } from "./handoff-peer-client.js";
import { currentListeningPort } from "./listening-port.js";

/** 绝大多数 ash 都听这个口;探测候选里必须有它,否则换过端口的机器一个都探不到。 */
const DEFAULT_PORT = 4317;
/** 探测是打开移回弹窗时的同步等待,全部并行发出,总耗时约等于一次超时。 */
const PROBE_TIMEOUT_MS = 1_500;
/** 候选上限:纯粹防「设置里配了几十台机器」把局域网刷一遍,正常只有两三个。 */
const MAX_PROBE_CANDIDATES = 12;

export function hostForUrl(address: string): string | null {
  const raw = address.trim().replace(/^::ffff:/i, "");
  const unwrapped = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  const normalized = unwrapped.split("%")[0] ?? "";
  if (isIP(normalized)) return normalized.includes(":") ? `[${normalized}]` : normalized;
  const hostname = domainToASCII(normalized);
  if (!hostname || hostname.length > 253
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i.test(hostname)) {
    return null;
  }
  return hostname;
}

export function sourceUrlFromPeer(address: string | undefined, port: unknown): string | null {
  const host = hostForUrl(address ?? "");
  const numericPort = Number(port);
  if (!host || !Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65_535) return null;
  return `http://${host}:${numericPort}`;
}

function portOfUrl(raw: string): number | null {
  try {
    const url = new URL(raw);
    if (url.port) return Number(url.port);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/**
 * 候选主机:来源机最近一次来访的 TCP 地址,加它自报的主机名(局域网里 `name` 和
 * `name.local` 两种写法都常见,mDNS 只认后者),最后兜上设置里登记过的那些主机 ——
 * 来源机换了网段时,用户能做的就是去「设置 → 远程主机」写上新地址,那条路得通。
 * 主机名不可信,但这里只当地址用,身份仍看指纹。
 */
function candidateHosts(marker: TaskHandoff, lastAddr: string, registeredUrls: string[]): string[] {
  const hosts: string[] = [];
  const push = (value: string | null) => {
    if (value && !hosts.includes(value)) hosts.push(value);
  };
  push(hostForUrl(lastAddr));
  const name = hostForUrl(marker.peerName ?? "");
  if (name && !isIP(name)) {
    push(name);
    if (!name.includes(".")) push(`${name}.local`);
  }
  for (const url of registeredUrls) {
    try { push(hostForUrl(new URL(url).hostname)); } catch { /* 设置里的坏地址不该拖垮探测 */ }
  }
  return hosts;
}

/** 候选端口:本机监听口(两台 ash 多半同构)、默认口,再加设置里登记过的那些。 */
function candidatePorts(registeredUrls: string[]): number[] {
  const ports: number[] = [];
  const push = (value: number | null) => {
    if (value && Number.isInteger(value) && value > 0 && value <= 65_535 && !ports.includes(value)) {
      ports.push(value);
    }
  };
  push(currentListeningPort());
  push(DEFAULT_PORT);
  for (const url of registeredUrls) push(portOfUrl(url));
  return ports;
}

/** 并行探一批地址,按候选顺序返回第一个**签名验得过**且指纹对得上的。 */
async function firstMatchingPeer(urls: string[], expectedFp: string): Promise<string | null> {
  const probes = await Promise.all(urls.map((url) => probeSignedPeerFingerprint(url, PROBE_TIMEOUT_MS)));
  for (const [index, fingerprint] of probes.entries()) {
    if (fingerprint && sameFingerprint(fingerprint, expectedFp)) return urls[index]!;
  }
  return null;
}

/**
 * 同一台来源机接力过来的**其它**任务里,新记录带着完整的 peerUrl(含端口)。旧记录
 * 缺端口时借用它最省事,也最可信 —— 那是同一台机器真实回连过的地址。
 */
async function peerUrlsFromSiblingTasks(peerFp: string): Promise<string[]> {
  const rows = await db.select({ handoff: tasks.handoff }).from(tasks);
  const urls: string[] = [];
  for (const row of rows) {
    if (!row.handoff) continue;
    let marker: TaskHandoff;
    try { marker = JSON.parse(row.handoff) as TaskHandoff; } catch { continue; }
    if (!marker.peerUrl || !marker.peerFp || !sameFingerprint(marker.peerFp, peerFp)) continue;
    const url = marker.peerUrl.replace(/\/+$/, "");
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

async function discoverReturnTarget(
  marker: TaskHandoff & { peerFp: string },
  registeredUrls: string[],
): Promise<HandoffTarget | null> {
  const [peer, siblingUrls] = await Promise.all([
    db.select({ lastAddr: handoffPeers.lastAddr }).from(handoffPeers)
      .where(eq(handoffPeers.fingerprint, marker.peerFp.trim().toLowerCase())).then((rows) => rows.at(0)),
    peerUrlsFromSiblingTasks(marker.peerFp),
  ]);
  const urls = [...siblingUrls];
  const hosts = candidateHosts(marker, peer?.lastAddr ?? "", registeredUrls);
  const ports = candidatePorts([...siblingUrls, ...registeredUrls]);
  for (const host of hosts) {
    for (const port of ports) {
      const url = `http://${host}:${port}`;
      if (!urls.includes(url)) urls.push(url);
    }
  }
  if (!urls.length) return null;
  const found = await firstMatchingPeer(urls.slice(0, MAX_PROBE_CANDIDATES), marker.peerFp);
  return found ? { name: marker.peerName || "来源机器", url: found, peerFp: marker.peerFp } : null;
}

export async function returnTargetForMarker(marker: TaskHandoff): Promise<HandoffTarget | null> {
  if (marker.direction !== "in" || !marker.peerFp) return null;
  const peerFp = marker.peerFp;
  // 任务本次导入时从真实 TCP 来源 + 对端自报端口恢复出的地址最新,也和这条任务绑定;
  // 设置项可能是 DHCP 变化前的旧地址,只作为老记录的兜底。
  if (marker.peerUrl) {
    return { name: marker.peerName || "来源机器", url: marker.peerUrl, peerFp };
  }
  const settings = await getAppSettings();
  const registeredUrls = settings.handoffTargets.map((target) => target.url);
  const registered = settings.handoffTargets.find((target) => target.peerFp
    && sameFingerprint(target.peerFp, peerFp));
  if (registered) {
    // 登记过的地址仍然优先,但先确认它现在还指向同一台机器:DHCP 换过租约之后这里
    // 常常是个死地址,而以前一路返回它,用户只能在弹窗里手填。探不通就继续往下推断,
    // 推断也失败才把它原样交回去(保持旧行为,不比以前差)。
    if (await firstMatchingPeer([registered.url], peerFp)) return registered;
    return (await discoverReturnTarget({ ...marker, peerFp }, registeredUrls)) ?? registered;
  }
  // 旧接力记录没存来源机端口(peerUrl 为空),而 handoff_peers 只有来访 IP。探一遍
  // 候选地址,指纹对上才用——详见文件顶部「猜错连不上,但绝不会猜到别的机器上」。
  return discoverReturnTarget({ ...marker, peerFp }, registeredUrls);
}

export async function returnTargetForTask(taskId: string): Promise<HandoffTarget | null> {
  const row = (await db.select({ handoff: tasks.handoff }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row?.handoff) return null;
  try {
    return await returnTargetForMarker(JSON.parse(row.handoff) as TaskHandoff);
  } catch {
    return null;
  }
}
