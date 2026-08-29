// 接力的**按人**那一层(§十一)。
//
// 计划的原则:接力不是管理员专属,所有人都要用;同时对端项目列表不得向发起人暴露他
// 无权看到的项目。两条合起来只推得出一个结论 —— **跨机身份 = 你在对端机器上的账号
// key**。与项目邀请同一哲学:要在那台机器上做事,就得在那台机器上有账号。
//
// 于是目标机清单必须按人存:里面装着「我在对端的 key」,那是凭证,不能进
// `app_settings`(`GET /settings` 会把整份吐回前端,一个打开的网页就拿走全部对端凭据)。
//
// 自用模式仍旧读写 `app_settings.handoffTargets`:那条路的行为必须与本功能上线前
// 逐字节一致,而且单人实例本来就没有「按人」可言。**但 key 是例外** —— 要不要 key
// 由**对端**的模式决定,自用实例往多人实例上接力同样得带。所以自用模式的 key 单独
// 存在 `handoff_local_peer_keys`(按 url),既不进那份会被整份吐回前端的设置,又能在
// 设置页和接力对话框里正常填写。
import { and, eq, inArray } from "drizzle-orm";
import type { HandoffTarget } from "@ash/shared";
import { getAppSettings, patchAppSettings } from "../app-settings.js";
import { db } from "../db/index.js";
import { handoffLocalPeerKeys, userHandoffTargets } from "../db/schema.js";
import { HandoffError } from "../handoff-types.js";
import { id, now } from "../util.js";
import type { Actor } from "./context.js";
import { ownerIdOf } from "./context.js";
import { isMultiUser } from "./mode.js";

/** 出站代码手上真正需要的形状:带明文 key,不出这一层。 */
export interface ResolvedTarget {
  id?: string;
  name: string;
  url: string;
  peerFp?: string | null;
  /** 我在对端的账号 key(明文)。空 = 没配。 */
  peerKey: string;
}

/** key 表的主键形态:去尾斜杠 + 小写,与 `sameUrl` 的判据是同一套。 */
const keyUrl = (raw: string): string => raw.trim().replace(/\/+$/, "").toLowerCase();

const sameUrl = (a: string, b: string): boolean => keyUrl(a) === keyUrl(b);

/** 自用模式的 key 表:url → 明文 key。没配过的地址读回空串。 */
async function localPeerKeys(): Promise<Map<string, string>> {
  const rows = await db.select().from(handoffLocalPeerKeys);
  return new Map(rows.map((row) => [row.url, row.peerKey]));
}

/** 这个人的目标机清单(**带明文 key**)。只给服务端出站路径用,绝不直接进应答。 */
export async function resolveTargetsFor(ownerUserId: string | null): Promise<ResolvedTarget[]> {
  if (!(await isMultiUser())) {
    const keys = await localPeerKeys();
    return (await getAppSettings()).handoffTargets.map((t) => ({
      name: t.name,
      url: t.url,
      peerFp: t.peerFp ?? null,
      peerKey: keys.get(keyUrl(t.url)) ?? "",
    }));
  }
  if (!ownerUserId) return [];
  const rows = await db.select().from(userHandoffTargets).where(eq(userHandoffTargets.userId, ownerUserId));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    peerFp: r.peerFp,
    peerKey: r.peerKey,
  }));
}

/** 给一个具体 URL 找目标机条目。出站前核指纹用它。 */
export async function targetForUrl(ownerUserId: string | null, url: string): Promise<ResolvedTarget | null> {
  return (await resolveTargetsFor(ownerUserId)).find((t) => sameUrl(t.url, url)) ?? null;
}

/**
 * 出站能用的「根地址 → key」。自用模式**直接读 key 表本身,不经过目标机清单** ——
 * 那张表才是自用模式的权威存储,清单只是设置页上的书签。经清单 join 的写法会漏掉一类
 * 真实情形:pending 重放收口时,弹框会为「已从设置里删掉、但任务还挂在它身上」的地址
 * 合成一个目标,用户在那儿填的 key 保存成功却永远发不出去。
 *
 * 多人模式没有这张表,key 就是那个人目标机行上的一列,清单即存储。
 */
async function outboundPeerKeys(ownerUserId: string | null): Promise<Map<string, string>> {
  if (!(await isMultiUser())) return localPeerKeys();
  return new Map(
    (await resolveTargetsFor(ownerUserId))
      .filter((t) => t.peerKey)
      .map((t) => [keyUrl(t.url), t.peerKey] as const),
  );
}

/**
 * 出站请求要带的 key。入参是一条具体请求的**完整 URL**
 * (`http://host:4317/api/handoff/ping?nonce=…`),而存储里是根地址,精确相等永远不成立
 * —— 2026-08-29 之前 `peerUserKeyHeader` 直接把完整 URL 拿去精确匹配,于是**每一个出站
 * 请求都不带 key**:用户配了 key,对端照样回「我不认识你」,而错误文案还在教他去配那把
 * 已经配好的 key。
 *
 * 匹配按最长前缀:目标机地址可能带路径前缀(反代到子路径),取 origin 会把它切掉。
 * 读侧只有这一个入口 —— 两个语义略有出入的读法,正是上面那个 bug 的成因。
 */
export async function peerKeyForRequest(ownerUserId: string | null, requestUrl: string): Promise<string> {
  const wanted = keyUrl(requestUrl);
  let best = "";
  let bestLen = 0;
  for (const [base, key] of await outboundPeerKeys(ownerUserId)) {
    if (!base || base.length < bestLen) continue;
    if (wanted === base || wanted.startsWith(`${base}/`) || wanted.startsWith(`${base}?`)) {
      best = key;
      bestLen = base.length;
    }
  }
  return best;
}

/** 展示用:抹掉 key,只报 hasKey。所有回给前端的路径都必须过这一层。 */
export function toPublicTarget(t: ResolvedTarget): HandoffTarget {
  return {
    ...(t.id ? { id: t.id } : {}),
    name: t.name,
    url: t.url,
    peerFp: t.peerFp ?? null,
    hasKey: !!t.peerKey,
  };
}

export async function listTargets(actor: Actor): Promise<HandoffTarget[]> {
  return (await resolveTargetsFor(ownerIdOf(actor))).map(toPublicTarget);
}

/**
 * 记住对端指纹(TOFU)。两种存储各写各的那一份 —— 出站代码只认这一个入口,
 * 免得多人模式下把指纹写进 app_settings 那份公共清单里。
 */
export async function rememberPeerFingerprint(
  ownerUserId: string | null,
  url: string,
  fingerprint: string,
): Promise<void> {
  if (!(await isMultiUser())) {
    const { handoffTargets } = await getAppSettings();
    const hit = handoffTargets.find((t) => sameUrl(t.url, url));
    if (!hit || hit.peerFp === fingerprint) return;
    await patchAppSettings({
      handoffTargets: handoffTargets.map((t) => (t === hit ? { ...t, peerFp: fingerprint } : t)),
    });
    return;
  }
  if (!ownerUserId) return;
  const hit = (await db.select().from(userHandoffTargets).where(eq(userHandoffTargets.userId, ownerUserId)))
    .find((t) => sameUrl(t.url, url));
  if (!hit || hit.peerFp === fingerprint) return;
  await db.update(userHandoffTargets).set({ peerFp: fingerprint }).where(eq(userHandoffTargets.id, hit.id));
}

// ── 写侧(设置页)────────────────────────────────────────────────────────────

export async function addTarget(
  actor: Actor,
  input: { name: string; url: string; peerKey?: string },
): Promise<HandoffTarget[]> {
  const owner = ownerIdOf(actor);
  if (!(await isMultiUser())) {
    const { handoffTargets } = await getAppSettings();
    await patchAppSettings({
      handoffTargets: [...handoffTargets, { name: input.name, url: input.url, peerFp: null }],
    });
    // 清单进设置,key 进单独的表 —— 自用模式同样可能要往多人对端接力。
    if (input.peerKey) await setPeerKey(actor, input.url, input.peerKey);
    return listTargets(actor);
  }
  if (!owner) throw new HandoffError("请先登录", 401);
  await db.insert(userHandoffTargets).values({
    id: id(),
    userId: owner,
    name: input.name,
    url: input.url,
    peerFp: null,
    peerKey: input.peerKey ?? "",
    createdAt: now(),
  });
  return listTargets(actor);
}

/**
 * 按**地址**写「我在对端的账号 key」。两种模式共用这一个入口,理由是调用点手上只有
 * 地址:接力对话框里选的是一台目标机(自用模式那份清单根本没有行 id),预检失败时要
 * 当场能补 key。多人模式落到这个人的那几行,自用模式落到 handoff_local_peer_keys。
 *
 * 空串 = 明确清空(对端转回单人实例了)。
 */
export async function setPeerKey(actor: Actor, rawUrl: string, peerKey: string): Promise<HandoffTarget[]> {
  const url = keyUrl(rawUrl);
  if (!url) throw new HandoffError("缺目标机地址", 400);
  if (peerKey.length > 512) throw new HandoffError("这把 key 太长了(上限 512 字符)", 400);
  if (!(await isMultiUser())) {
    // 不校验「这个地址还在不在清单里」是**故意的**:pending 重放收口时,弹框会为
    // 「已从设置里删掉、但任务还挂在它身上」的地址合成一个目标,那里填的 key 必须真的
    // 能用。出站读侧直接读这张表,所以写下去就生效(见 `outboundPeerKeys`)。
    if (peerKey) {
      await db.insert(handoffLocalPeerKeys).values({ url, peerKey, updatedAt: now() })
        .onConflictDoUpdate({
          target: handoffLocalPeerKeys.url,
          set: { peerKey, updatedAt: now() },
        });
    } else {
      await db.delete(handoffLocalPeerKeys).where(eq(handoffLocalPeerKeys.url, url));
    }
    return listTargets(actor);
  }
  const owner = ownerIdOf(actor);
  if (!owner) throw new HandoffError("请先登录", 401);
  const rows = (await db.select().from(userHandoffTargets).where(eq(userHandoffTargets.userId, owner)))
    .filter((row) => sameUrl(row.url, url));
  if (!rows.length) {
    throw new HandoffError("先把这台目标机加进「我的接力目标机」,再给它配 key", 404);
  }
  // 同一个地址被登记了两行时一起写:「我在那台机器上的 key」只可能是同一把。
  await db.update(userHandoffTargets).set({ peerKey })
    .where(inArray(userHandoffTargets.id, rows.map((row) => row.id)));
  return listTargets(actor);
}

/**
 * 自用模式:目标机从设置里被删掉后,顺手把它那把 key 也删了。留着不会泄露(出站要先
 * 拿到地址才用得上),但「删掉再加回同一个地址,旧 key 悄悄复活」是会让人查半天的意外
 * 行为。由 `patchSettingsFor` 在 handoffTargets 落库后调用。
 *
 * 入参是**改动前后的两份清单**,删的只有「这次被拿掉的那几个地址」。早先那版收的是
 * 「留下来的地址」、把一切对不上的行都当孤儿删掉,会连带清掉**故意为不在清单里的地址
 * 配的 key**(pending 重放那种):用户配完当场能用,随手改一下别的目标机就又不能用了。
 */
export async function forgetRemovedPeerKeys(
  before: readonly { url: string }[],
  after: readonly { url: string }[],
): Promise<void> {
  if (await isMultiUser()) return;
  const kept = new Set(after.map((t) => keyUrl(t.url)));
  const removed = [...new Set(before.map((t) => keyUrl(t.url)))].filter((url) => !kept.has(url));
  if (removed.length) {
    await db.delete(handoffLocalPeerKeys).where(inArray(handoffLocalPeerKeys.url, removed));
  }
}

export async function patchTarget(
  actor: Actor,
  targetId: string,
  patch: { name?: string; url?: string; peerKey?: string; peerFp?: string | null },
): Promise<HandoffTarget[]> {
  const owner = ownerIdOf(actor);
  if (!(await isMultiUser()) || !owner) throw new HandoffError("自用模式的目标机清单在「设置 → 默认规则」里改", 409);
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name;
  // 换了地址就把记住的指纹一起清掉:那是**另一台机器**了,留着旧指纹反而会让
  // 「对不上就拒绝打包」这道闸变成误报。
  if (patch.url !== undefined) {
    set.url = patch.url;
    set.peerFp = null;
  }
  // 空串 = 明确清空(对端转回单人实例了);undefined = 不动这一列。
  if (patch.peerKey !== undefined) set.peerKey = patch.peerKey;
  if (patch.peerFp !== undefined) set.peerFp = patch.peerFp;
  if (Object.keys(set).length) {
    await db.update(userHandoffTargets).set(set)
      .where(and(eq(userHandoffTargets.id, targetId), eq(userHandoffTargets.userId, owner)));
  }
  return listTargets(actor);
}

export async function deleteTarget(actor: Actor, targetId: string): Promise<HandoffTarget[]> {
  const owner = ownerIdOf(actor);
  if (!(await isMultiUser()) || !owner) throw new HandoffError("自用模式的目标机清单在「设置 → 默认规则」里改", 409);
  await db.delete(userHandoffTargets)
    .where(and(eq(userHandoffTargets.id, targetId), eq(userHandoffTargets.userId, owner)));
  return listTargets(actor);
}
