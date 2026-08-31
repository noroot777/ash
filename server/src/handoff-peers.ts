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
import { handoffPeers, users } from "./db/schema.js";
import { getAppSettings } from "./app-settings.js";
import { HandoffError } from "./handoff-types.js";
import {
  canonicalRequest, fingerprintOf, sha256Hex, shortFingerprint, verifyWithPeerKey,
} from "./handoff-identity.js";
import type { Actor } from "./auth/context.js";
import { isAccountHolder, ownerIdOf } from "./auth/context.js";
import { now } from "./util.js";

export const PEER_HEADERS = {
  key: "x-ash-peer-key",
  sig: "x-ash-peer-sig",
  ts: "x-ash-peer-ts",
  nonce: "x-ash-peer-nonce",
  host: "x-ash-peer-host",
  // 对端自报的实例模式,形如 `single` / `multi:3`。**不可信**(同 host 头,自报的),
  // 不进签名 —— 它不是权限判据,只让批准的人知道自己在批什么:批一台多人实例
  // = 那台机器上**所有人**都能经这条路接力进来(§十一 多人→单人 那一格)。
  mode: "x-ash-peer-mode",
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
  /** 对端自述的实例模式(`single` / `multi:<人数>`),不可信,只用于让人知情批准。 */
  mode: string;
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
    mode: h(PEER_HEADERS.mode).slice(0, 32),
  };
}

/**
 * 记一次来访。
 *
 * `create` 决定陌生指纹要不要落成一条待批准记录 —— 这一位是 2026-08-31 那次
 * 「我没申请过接力，却天天收到申请」的正解。在那之前 touchPeer 无条件建 pending,
 * 于是**任何**带签名的请求都会变成对端的一条「接力申请」:出站侧栏每 20 秒问一次
 * 「我交出去那条任务现在什么样」(/proxy/tasks/state),对端就每 20 秒收到一次申请,
 * 而真正的申请入口 /handoff/request 反倒是最少走的那条。
 *
 * 现在的判据按**端点性质**分,不看请求自报的任何东西:
 *   · 配对入口(/handoff/ping,且源机没声明只是探测) → create,这是它的本职
 *   · 已建立关系的通道(/refs、/import、/proxy/*,走 requireApprovedPeer) → 不 create,
 *     陌生指纹一律 401 并指路「先在源机点一次申请」
 *
 * 返回 null = 没这条记录、且这次不许建。
 */
export async function touchPeer(
  peer: VerifiedPeer,
  addr: string,
  options: { create: boolean; requestedBy?: string | null },
): Promise<HandoffPeer | null> {
  const at = now();
  const existing = (await db.select().from(handoffPeers)
    .where(eq(handoffPeers.fingerprint, peer.fingerprint))).at(0);
  const peerMode = peer.mode || existing?.peerMode || "";
  if (existing) {
    // 归属只在**还没人处置过**时补写:已批准/已拒绝的记录归属谁不再影响可见性,
    // 而后来换一把 key 敲门不该悄悄把一条别人批过的记录改挂到自己名下。
    const requestedByUserId = existing.status === "pending" && options.requestedBy
      ? options.requestedBy
      : existing.requestedByUserId;
    await db.update(handoffPeers)
      .set({
        publicKey: peer.publicKey, lastSeenAt: at, lastAddr: addr,
        name: peer.name || existing.name, peerMode, requestedByUserId,
      })
      .where(eq(handoffPeers.fingerprint, peer.fingerprint));
    return toPeer({
      ...existing,
      publicKey: peer.publicKey,
      lastSeenAt: at,
      lastAddr: addr,
      name: peer.name || existing.name,
      peerMode,
      requestedByUserId,
    });
  }
  if (!options.create) return null;
  const row = {
    fingerprint: peer.fingerprint,
    publicKey: peer.publicKey,
    name: peer.name,
    status: "pending",
    firstSeenAt: at,
    lastSeenAt: at,
    approvedAt: null,
    approvedBy: null,
    peerMode,
    lastAddr: addr,
    requestedByUserId: options.requestedBy ?? null,
  };
  await db.insert(handoffPeers).values(row).onConflictDoNothing();
  return toPeer(row);
}

const toPeer = (
  row: typeof handoffPeers.$inferSelect,
  extra?: { byName?: string; requestedByName?: string; seenAsAdmin?: boolean; canApprove?: boolean },
): HandoffPeer => ({
  fingerprint: row.fingerprint,
  short: shortFingerprint(row.fingerprint),
  name: row.name,
  status: (row.status === "approved" || row.status === "blocked" ? row.status : "pending"),
  firstSeenAt: row.firstSeenAt,
  lastSeenAt: row.lastSeenAt,
  approvedAt: row.approvedAt,
  ...(extra?.byName ? { approvedByName: extra.byName } : {}),
  ...(extra?.requestedByName ? { requestedByName: extra.requestedByName } : {}),
  ...(extra?.seenAsAdmin ? { seenAsAdmin: true } : {}),
  ...(extra?.canApprove === undefined ? {} : { canApprove: extra.canApprove }),
  ...(row.peerMode ? { peerMode: row.peerMode } : {}),
  lastAddr: row.lastAddr,
  returnOnly: !row.publicKey,
});

/**
 * 谁看得见、动得了这条来源记录(用户 2026-08-31 拍板)。
 *
 * 原来是「全员可见可批」(§十一 互信定位)。那一条只说对了一半:**发申请**确实不是
 * 管理员专属,谁都可以发;但一条申请该打扰的只有它冲着的那个人 —— 源机发申请时带的
 * 「我在对端的账号 key」已经说明了它要以谁的身份进来,对端没有理由把它推给另外几个
 * 不相干的人,更不该让他们替本人处置。
 *
 * 判据按**这一行处在哪一档**分,不按角色分(第 2 轮审查 P1):
 *
 *   · `pending` = 一封还没人拆的信,**只有收信人**。看不见、拒不了、也删不掉 ——
 *     管理员在这一档什么都不是。用户的原话就是「只有发送请求的那个用户才能看得见,
 *     并操作是否接受」,而「替你拒了」和「替你批了」一样是替人做决定:源机那边只会
 *     看到一句「对方拒绝了」,当事人根本不知道有人来找过他。
 *   · `approved` / `blocked` = 已经进了**实例级信任表**,本人 + 实例管理员都看得见。
 *     一台 approved 的机器意味着它上面所有人都敲得开本机的门,人走了、key 换了总得
 *     有人撤销得掉,否则就是一批谁也动不了的孤儿。管理员在这一档能拒(收权)、能删
 *     (清理),但**批不了**:`approve` 和把 blocked 解回 approved 都是放行,是扩权。
 *
 * 升级前落下的无主 pending 老行因此对所有人不可见 —— 这是对的,不是漏了一档:它没
 * 放行任何东西(pending 进不来),而源机一旦按新流程重发申请,touchPeer 会就地把归属
 * 补上(那一行还在 pending),它自己就回到收信人手里了。
 *
 * **agent 回合凭证一律不算本人**。它身上挂的 owner userId 是归属戳,不是「它就是这个
 * 人」(auth/context.ts `isAccountHolder`)。不判这一条的话,任意一条正在跑的任务只凭
 * `x-ash-source-task-id` + `x-ash-turn-token` 就能替 owner 放行一台陌生机器,还把操作人
 * 记成 owner 本人(第 1 轮审查 P1 实测复现)。写侧另有 `personal-gate.ts` 的中间件兜底,
 * 两道都要 —— 判据自己立不住的话,中间件那份路径名单迟早会漏掉一条。
 *
 * 自用模式恒真:没有用户概念,机器级配对即全部授权。
 */
export function peerAudience(
  actor: Actor,
  row: { requestedByUserId?: string | null; status?: string | null },
): { visible: boolean; asAdmin: boolean; canApprove: boolean } {
  if (actor.kind === "single") return { visible: true, asAdmin: false, canApprove: true };
  // agent 不是账号本人:读写两侧一起挡,别让它连别人的申请列表都翻得到。
  if (!isAccountHolder(actor)) return { visible: false, asAdmin: false, canApprove: false };
  const owner = row.requestedByUserId ?? null;
  if (owner && actor.userId && actor.userId === owner) {
    return { visible: true, asAdmin: false, canApprove: true };
  }
  // 别人的**待批准申请**对谁都不存在,管理员也一样。
  if (row.status === "pending" || !row.status) return { visible: false, asAdmin: false, canApprove: false };
  return actor.role === "admin"
    ? { visible: true, asAdmin: true, canApprove: false }
    : { visible: false, asAdmin: false, canApprove: false };
}

/**
 * 入站来源名单。多人模式下按 `peerAudience` 收窄 —— 这是一条会被前端横幅直接消费的
 * 列表,不收窄的话「只打扰本人」在后端做了也白做。
 */
export async function listPeers(actor: Actor): Promise<HandoffPeer[]> {
  const rows = await db.select().from(handoffPeers);
  // 谁批的 / 谁申请的都要显示成人名而不是 id —— 多人模式下这行字是「这台机器怎么进来的」的唯一线索。
  const names = new Map((await db.select({ id: users.id, name: users.name }).from(users))
    .map((u) => [u.id, u.name] as const));
  // 待批准的排前面:那是唯一需要用户动手的一档。
  const rank = (s: string) => (s === "pending" ? 0 : s === "approved" ? 1 : 2);
  return rows
    .flatMap((row) => {
      const audience = peerAudience(actor, row);
      if (!audience.visible) return [];
      return [toPeer(row, {
        ...(row.approvedBy ? { byName: names.get(row.approvedBy) ?? "(已删除)" } : {}),
        ...(row.requestedByUserId
          ? { requestedByName: names.get(row.requestedByUserId) ?? "(已删除)" }
          : {}),
        ...(audience.asAdmin ? { seenAsAdmin: true } : {}),
        canApprove: audience.canApprove,
      })];
    })
    .sort((a, b) => rank(a.status) - rank(b.status) || b.lastSeenAt.localeCompare(a.lastSeenAt));
}

/**
 * 处置前的同一道闸。看不见的记录一律回「没有这台机器」,免得拿指纹试探别人的申请。
 * `approving` 为真时再加一道:放行只有本人做得了(见 `peerAudience`)。这一档要**明说**
 * 而不是回 404 —— 走到这里说明这条记录在他自己的列表里就看得见(已 approved/blocked 的
 * 实例信任表),回「没有这台机器」只会让人以为界面坏了。
 */
async function requirePeerActable(
  actor: Actor,
  fingerprint: string,
  approving = false,
): Promise<typeof handoffPeers.$inferSelect | null> {
  const row = (await db.select().from(handoffPeers).where(eq(handoffPeers.fingerprint, fingerprint))).at(0);
  if (!row) return null;
  const audience = peerAudience(actor, row);
  if (!audience.visible) {
    throw new HandoffError("没有这台接力来源机器(指纹对不上)", 404);
  }
  if (approving && !audience.canApprove) {
    throw new HandoffError(
      "放行一台来源机器只有它冲着的那个人点得了 —— 那等于让它上面所有人都敲得开本机的门。"
      + "你可以拒绝或删除它,但放行得由本人来。",
      403,
    );
  }
  return row;
}

/**
 * 批准 / 拒绝一台入站机器。谁能点由 `peerAudience` 定:接受只有本人,拒绝本人和实例
 * 管理员都行。`by` 必填 —— 放行一台机器等于让它上面所有人都敲得开本机的门,事后必须
 * 能问出是谁点的。
 */
export async function setPeerStatus(
  actor: Actor,
  fingerprint: string,
  status: "approved" | "blocked",
): Promise<HandoffPeer> {
  const by = ownerIdOf(actor);
  const normalized = fingerprint.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new HandoffError("机器指纹格式不正确", 400);
  const row = await requirePeerActable(actor, normalized, status === "approved");
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
      approvedBy: by ?? null,
      peerMode: "",
      lastAddr: "",
      // 凭空建的拒绝记录归属点它的人:这样别人不会在名单里看到一条来路不明的黑名单。
      requestedByUserId: by ?? null,
    };
    await db.insert(handoffPeers).values(blocked).onConflictDoUpdate({
      target: handoffPeers.fingerprint,
      set: { status: "blocked", approvedAt: null, approvedBy: by ?? null },
    });
    const stored = (await db.select().from(handoffPeers)
      .where(eq(handoffPeers.fingerprint, normalized))).at(0);
    return toPeer(stored ?? blocked);
  }
  if (status === "approved" && !row.publicKey) {
    throw new HandoffError("这条记录只用于拒绝历史回程，不能直接升级为整机批准；先让对方重新发送接力申请", 409);
  }
  // 拉黑不是忘记：保留已有批准时间，解除时才能恢复原来的 approved；从未批准过的
  // pending 行 approvedAt 仍为空，解除后也只回 pending，不能借一次 block/unblock 提权。
  const approvedAt = status === "approved" ? now() : row.approvedAt;
  // 操作人记的是**最近一次动它的人**(批准或拒绝),不是「最初批准的人」——
  // 要回答的问题是「现在这个状态是谁定的」。
  const approvedBy = by ?? row.approvedBy;
  await db.update(handoffPeers).set({ status, approvedAt, approvedBy })
    .where(eq(handoffPeers.fingerprint, normalized));
  return toPeer({ ...row, status, approvedAt, approvedBy });
}

export async function unblockPeer(actor: Actor, fingerprint: string): Promise<HandoffPeer | null> {
  const normalized = fingerprint.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new HandoffError("机器指纹格式不正确", 400);
  // 解除拒绝会把**曾经批准过**的记录直接送回 approved —— 那一档是放行,同样只有本人
  // 能点,否则管理员一个 block+unblock 就绕开了「接受得由本人来」。没批准过的只回
  // pending(不是放行),谁都能解。判定要在读库之后,所以先不带 approving 取一次行。
  const peek = (await db.select().from(handoffPeers).where(eq(handoffPeers.fingerprint, normalized))).at(0);
  const row = await requirePeerActable(actor, normalized, Boolean(peek?.approvedAt));
  if (!row) throw new HandoffError("没有这台已拒绝的机器(指纹对不上)", 404);
  if (row.status !== "blocked") throw new HandoffError("这台机器当前没有被拒绝", 409);
  if (!row.publicKey) {
    await db.delete(handoffPeers).where(eq(handoffPeers.fingerprint, normalized));
    return null;
  }
  const status = row.approvedAt ? "approved" as const : "pending" as const;
  await db.update(handoffPeers).set({ status }).where(eq(handoffPeers.fingerprint, normalized));
  return toPeer({ ...row, status });
}

export async function deletePeer(actor: Actor, fingerprint: string): Promise<void> {
  // 校验和删除必须用**同一个**串:指纹在库里一律小写,拿原样的大写指纹去 delete 会
  // 一行都不匹配,端点却照样回 {deleted:true}(第 2 轮审查 P3)。
  const normalized = fingerprint.trim().toLowerCase();
  // 看不见就删不掉:否则「只打扰本人」在读侧做了,写侧还能拿指纹把别人的记录抹掉。
  await requirePeerActable(actor, normalized);
  await db.delete(handoffPeers).where(eq(handoffPeers.fingerprint, normalized));
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
  // **不建新记录**:这条通道是给已经配好对的机器走的,陌生指纹到这儿一律拒。
  // 建了的话,源机的自动状态轮询就会源源不断地在这台机器上刷出「接力申请」——
  // 那正是 2026-08-31 那次「我没申请过却天天收到申请」的成因(见 touchPeer 顶部)。
  if (peer) await touchPeer(peer, peerAddr(c), { create: false });
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
  // 两种没批准分开说:**这条通道不再自动建待批准记录**(见上面的 create:false),
  // 所以「已经在它的待批列表里等着」只对确实申请过的那种成立。对没申请过的说那句话
  // 会让人跑到对端设置页里对着一张空表发愣。
  if (row) {
    throw new HandoffError(
      `目标机还没批准这台来源机器。到目标机「设置 → 默认规则 → 接力来源」批准指纹 ${shortFingerprint(peer.fingerprint)} 后重试(这次申请已经在它的待批准列表里等着)。`,
      401,
    );
  }
  throw new HandoffError(
    `这台机器还没跟目标机配过对(指纹 ${shortFingerprint(peer.fingerprint)})。到本机「设置 → 默认规则 → 接力目标机」对它点一次「发送接力申请」,再让目标机上对应的人批准。`,
    401,
  );
}
