// 接力**入站**守卫:谁能把任务接力进本机。
//
// 三件事:
//   1. 验签 —— 请求头带公钥 + 对「方法+路径+时间戳+nonce+body 哈希」的 ed25519 签名。
//      指纹由公钥现算(sha256),所以冒充一个已批准的指纹必须持有对应私钥;body 哈希进
//      签名,中间人留着签名头改 manifest 也过不了(接力的 body 就是整个仓库和会话历史)。
//   2. 防重放 —— 时间戳超窗(±5 分钟)或 nonce 见过就拒。幂等收口重试不受影响:那是
//      一次全新请求,自带新的 ts/nonce,幂等靠 manifest 里的 transferId,两套机制不打架。
//   3. 批准 —— 陌生指纹一律落成 pending 并拒绝,让用户在设置页点一下放行(Syncthing
//      那套配对模型)。比预共享 key 好在:不用手工在两台机器之间搬秘密,而且谁来敲过门
//      有据可查。
//
// 这里只管**入站**。出站方向(「我要发的这台还是不是原来那台」)在
// handoff-peer-client.ts —— 那一半才是接力最该防的,见 handoff-identity.ts 顶部。
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { eq } from "drizzle-orm";
import type { HandoffPeer } from "@ash/shared";
import { db } from "./db/index.js";
import { handoffPeers } from "./db/schema.js";
import { getAppSettings } from "./app-settings.js";
import { HandoffError } from "./handoff-types.js";
import {
  canonicalRequest, fingerprintOf, sha256Hex, shortFingerprint, verifyWithPeerKey,
} from "./handoff-identity.js";
import { now } from "./util.js";

export const PEER_HEADERS = {
  key: "x-ash-peer-key",
  sig: "x-ash-peer-sig",
  ts: "x-ash-peer-ts",
  nonce: "x-ash-peer-nonce",
  host: "x-ash-peer-host",
} as const;

/** 时间戳容忍窗口。两台机器的表差几分钟很常见,但更宽就等于给重放留窗口。 */
const SKEW_MS = 5 * 60_000;

// 见过的 nonce:值是过期时刻。只需活过 SKEW_MS —— 更早的时间戳已经被窗口本身挡掉了。
// 进程内存足够:singleton.ts 保证同一个库只有一个 server 进程。上限是防内存被刷爆的
// 兜底(超了就整片丢掉,退化成只靠时间窗)。
//
// **重启会清空它**,所以窗口内抓到的请求在重启后确实能重放一次 —— 这是知情的取舍,
// 不是「重启后请求都过期了」(重启只要几秒)。之所以可以接受:唯一有副作用的端点是
// /import,而它由 manifest 里的 transferId 做幂等收口,重放只会拿回同一个结果;
// /refs 是只读。真要跨重启就得把 nonce 落库,那是给一个没有实际危害的场景加写放大。
const seenNonces = new Map<string, number>();
const MAX_NONCES = 20_000;

function rememberNonce(nonce: string, atMs: number): boolean {
  const nowMs = Date.now();
  if (seenNonces.size > MAX_NONCES) seenNonces.clear();
  for (const [key, expiry] of seenNonces) {
    if (expiry <= nowMs) seenNonces.delete(key);
    else break; // Map 按插入序,后面的更晚过期
  }
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, atMs + SKEW_MS);
  return true;
}

/** 只给测试用:清掉 nonce 缓存。 */
export function resetPeerNonces(): void {
  seenNonces.clear();
}

function decodeHost(raw: string): string {
  try {
    return decodeURIComponent(raw).slice(0, 64);
  } catch {
    return raw.slice(0, 64);
  }
}

export interface VerifiedPeer {
  fingerprint: string;
  publicKey: string;
  /** 对端自述的主机名,不可信,只用于展示。 */
  name: string;
}

/**
 * 验签。没带签名头 → 返回 null(旧版对端,由调用方按审批开关决定收不收);
 * 带了但验不过 → 直接抛,不给「签坏了就当没签」的降级路径。
 */
export function verifyPeerSignature(c: Context, rawBody: string | Buffer): VerifiedPeer | null {
  const h = (name: string) => c.req.header(name)?.trim() ?? "";
  const publicKey = h(PEER_HEADERS.key);
  const sig = h(PEER_HEADERS.sig);
  const ts = h(PEER_HEADERS.ts);
  const nonce = h(PEER_HEADERS.nonce);
  if (!publicKey && !sig && !ts && !nonce) return null;
  if (!publicKey || !sig || !ts || !nonce) throw new HandoffError("接力身份签名头不完整", 401);
  const atMs = Number(ts);
  if (!Number.isFinite(atMs)) throw new HandoffError("接力签名时间戳非法", 401);
  if (Math.abs(Date.now() - atMs) > SKEW_MS) {
    throw new HandoffError(
      `接力签名时间戳超出 ±5 分钟窗口(对端 ${new Date(atMs).toISOString()},本机 ${new Date().toISOString()})。两台机器的系统时间对一下。`,
      401,
    );
  }
  if (nonce.length < 8 || nonce.length > 128) throw new HandoffError("接力签名 nonce 非法", 401);
  const canonical = canonicalRequest({
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    ts,
    nonce,
    bodyHash: sha256Hex(rawBody),
  });
  if (!verifyWithPeerKey(publicKey, canonical, sig)) {
    throw new HandoffError("接力身份签名验不过(请求在路上被改过,或对端用的不是它自称的那把密钥)", 401);
  }
  // 验签通过之后才记 nonce:验不过的请求不该能污染缓存把后面的真请求顶掉。
  if (!rememberNonce(nonce, atMs)) throw new HandoffError("这次接力请求是重放的(nonce 已用过)", 401);
  return {
    fingerprint: fingerprintOf(publicKey),
    publicKey,
    // 出站侧 percent 编码过(主机名可能是中文);解不开就按原样收,反正只用于展示。
    name: decodeHost(h(PEER_HEADERS.host)),
  };
}

/** 记一次来访:没见过的落 pending(这就是配对请求本身),见过的只刷新时间与地址。 */
export async function touchPeer(peer: VerifiedPeer, addr: string): Promise<HandoffPeer> {
  const at = now();
  const existing = (await db.select().from(handoffPeers)
    .where(eq(handoffPeers.fingerprint, peer.fingerprint))).at(0);
  if (existing) {
    await db.update(handoffPeers)
      .set({ publicKey: peer.publicKey, lastSeenAt: at, lastAddr: addr, name: peer.name || existing.name })
      .where(eq(handoffPeers.fingerprint, peer.fingerprint));
    return toPeer({
      ...existing,
      publicKey: peer.publicKey,
      lastSeenAt: at,
      lastAddr: addr,
      name: peer.name || existing.name,
    });
  }
  const row = {
    fingerprint: peer.fingerprint,
    publicKey: peer.publicKey,
    name: peer.name,
    status: "pending",
    firstSeenAt: at,
    lastSeenAt: at,
    approvedAt: null,
    lastAddr: addr,
  };
  await db.insert(handoffPeers).values(row).onConflictDoNothing();
  return toPeer(row);
}

const toPeer = (row: typeof handoffPeers.$inferSelect): HandoffPeer => ({
  fingerprint: row.fingerprint,
  short: shortFingerprint(row.fingerprint),
  name: row.name,
  status: (row.status === "approved" || row.status === "blocked" ? row.status : "pending"),
  firstSeenAt: row.firstSeenAt,
  lastSeenAt: row.lastSeenAt,
  approvedAt: row.approvedAt,
  lastAddr: row.lastAddr,
  returnOnly: !row.publicKey,
});

export async function listPeers(): Promise<HandoffPeer[]> {
  const rows = await db.select().from(handoffPeers);
  // 待批准的排前面:那是唯一需要用户动手的一档。
  const rank = (s: string) => (s === "pending" ? 0 : s === "approved" ? 1 : 2);
  return rows.map(toPeer).sort((a, b) => rank(a.status) - rank(b.status) || b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export async function setPeerStatus(fingerprint: string, status: "approved" | "blocked"): Promise<HandoffPeer> {
  const normalized = fingerprint.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new HandoffError("机器指纹格式不正确", 400);
  const row = (await db.select().from(handoffPeers).where(eq(handoffPeers.fingerprint, normalized))).at(0);
  if (!row) {
    if (status !== "blocked") throw new HandoffError("没有这台接力来源机器(指纹对不上)", 404);
    const at = now();
    const blocked = {
      fingerprint: normalized,
      publicKey: "",
      name: "",
      status: "blocked",
      firstSeenAt: at,
      lastSeenAt: at,
      approvedAt: null,
      lastAddr: "",
    };
    await db.insert(handoffPeers).values(blocked).onConflictDoUpdate({
      target: handoffPeers.fingerprint,
      set: { status: "blocked", approvedAt: null },
    });
    const stored = (await db.select().from(handoffPeers)
      .where(eq(handoffPeers.fingerprint, normalized))).at(0);
    return toPeer(stored ?? blocked);
  }
  if (status === "approved" && !row.publicKey) {
    throw new HandoffError("这条记录只用于拒绝历史回程，不能直接升级为整机批准；先让对方重新发送接力申请", 409);
  }
  const approvedAt = status === "approved" ? now() : null;
  await db.update(handoffPeers).set({ status, approvedAt }).where(eq(handoffPeers.fingerprint, normalized));
  return toPeer({ ...row, status, approvedAt });
}

export async function deletePeer(fingerprint: string): Promise<void> {
  await db.delete(handoffPeers).where(eq(handoffPeers.fingerprint, fingerprint));
}

/** 客户端真实 TCP 地址。反代场景会看到网关地址；不信任可伪造的 X-Forwarded-For。 */
export function peerAddr(c: Context): string {
  try { return (getConnInfo(c).remote.address ?? "").slice(0, 64); } catch { return ""; }
}

/** ping 应答里对源机的态度自述(源机据此在预检结果里如实告诉用户下一步该干什么)。 */
export type PeerStance = "approved" | "pending" | "blocked" | "open" | "unknown";

export async function peerStanceFor(peer: VerifiedPeer | null, requireApproval: boolean): Promise<PeerStance> {
  if (!requireApproval) return "open";
  if (!peer) return "unknown";
  const row = (await db.select().from(handoffPeers).where(eq(handoffPeers.fingerprint, peer.fingerprint))).at(0);
  if (!row) return "pending";
  return row.status === "approved" ? "approved" : row.status === "blocked" ? "blocked" : "pending";
}

/**
 * 机器对机器写入端点(/refs、/import)的通行证:验签 + 记来访 + 查批准。
 * 抛出的 HandoffError 都带「可证明没落库」语义(unsettled=false),源机收到后会回滚
 * 接力标记而不是留 pending —— 鉴权拒绝确实什么都没导入,让它在本机原地可跑才对。
 * 返回值:验过的对端(没开审批且对端没签名时为 null)。
 */
export async function requireApprovedPeer(c: Context, rawBody: string | Buffer): Promise<VerifiedPeer | null> {
  const settings = await getAppSettings();
  const peer = verifyPeerSignature(c, rawBody);
  if (peer) await touchPeer(peer, peerAddr(c));
  if (!settings.handoffRequireApproval) return peer;
  if (!peer) {
    throw new HandoffError(
      "目标机开启了接力来源审批,但这次请求没带身份签名 —— 来源机器多半是不支持身份校验的旧版 ash。升级源机,或到目标机「设置 → 默认规则 → 接力来源」临时关掉审批。",
      401,
    );
  }
  const row = (await db.select().from(handoffPeers).where(eq(handoffPeers.fingerprint, peer.fingerprint))).at(0);
  if (row?.status === "approved") return peer;
  if (row?.status === "blocked") {
    throw new HandoffError(`目标机已明确拒绝这台来源机器(指纹 ${shortFingerprint(peer.fingerprint)})。`, 403);
  }
  throw new HandoffError(
    `目标机还没批准这台来源机器。到目标机「设置 → 默认规则 → 接力来源」批准指纹 ${shortFingerprint(peer.fingerprint)} 后重试(这台机器已经出现在它的待批准列表里)。`,
    401,
  );
}
