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
// 逐字节一致,而且单人实例本来就没有「按人」可言。
import { and, eq } from "drizzle-orm";
import type { HandoffTarget } from "@ash/shared";
import { getAppSettings, patchAppSettings } from "../app-settings.js";
import { db } from "../db/index.js";
import { userHandoffTargets } from "../db/schema.js";
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

const sameUrl = (a: string, b: string): boolean =>
  a.trim().replace(/\/+$/, "").toLowerCase() === b.trim().replace(/\/+$/, "").toLowerCase();

/** 这个人的目标机清单(**带明文 key**)。只给服务端出站路径用,绝不直接进应答。 */
export async function resolveTargetsFor(ownerUserId: string | null): Promise<ResolvedTarget[]> {
  if (!(await isMultiUser())) {
    return (await getAppSettings()).handoffTargets.map((t) => ({
      name: t.name,
      url: t.url,
      peerFp: t.peerFp ?? null,
      peerKey: "",
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

/** 给一个具体 URL 找目标机条目。出站前核指纹、取 key 都用它。 */
export async function targetForUrl(ownerUserId: string | null, url: string): Promise<ResolvedTarget | null> {
  return (await resolveTargetsFor(ownerUserId)).find((t) => sameUrl(t.url, url)) ?? null;
}

/** 我在对端的 key。没配就是空串 —— 调用方据此给出「去找对端管理员开账号」那句话。 */
export async function peerKeyFor(ownerUserId: string | null, url: string): Promise<string> {
  return (await targetForUrl(ownerUserId, url))?.peerKey ?? "";
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
