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
import { getAppSettings, invalidateInstanceCache, parseAppSettingsPatch, patchAppSettings, writeAppSettingsPatch } from "../app-settings.js";
import { db } from "../db/index.js";
import { appSettings, handoffLocalPeerKeys, userHandoffTargets } from "../db/schema.js";
import { sameFingerprint } from "../handoff-identity.js";
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
  peerKeyFp?: string | null;
}

/** key 表的主键形态:去尾斜杠 + 小写,与 `sameUrl` 的判据是同一套。 */
const keyUrl = (raw: string): string => raw.trim().replace(/\/+$/, "").toLowerCase();

const sameUrl = (a: string, b: string): boolean => keyUrl(a) === keyUrl(b);

/** 自用模式的 key 和它在保存时核对的机器指纹一起读取。 */
async function localPeerKeys(): Promise<Map<string, typeof handoffLocalPeerKeys.$inferSelect>> {
  const rows = await db.select().from(handoffLocalPeerKeys);
  return new Map(rows.map((row) => [row.url, row]));
}

/** 这个人的目标机清单(**带明文 key**)。只给服务端出站路径用,绝不直接进应答。 */
export async function resolveTargetsFor(ownerUserId: string | null): Promise<ResolvedTarget[]> {
  if (!(await isMultiUser())) {
    const keys = await localPeerKeys();
    return (await getAppSettings()).handoffTargets.map((t) => ({
      name: t.name,
      url: t.url,
      peerFp: t.peerFp ?? null,
      peerKey: keys.get(keyUrl(t.url))?.peerKey ?? "",
      peerKeyFp: keys.get(keyUrl(t.url))?.peerFp ?? null,
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
    peerKeyFp: r.peerKeyFp,
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
async function outboundPeerKeys(ownerUserId: string | null) {
  if (!(await isMultiUser())) return [...(await localPeerKeys()).values()];
  return (await resolveTargetsFor(ownerUserId)).map((target) => ({
    url: target.url, peerKey: target.peerKey, peerFp: target.peerKeyFp ?? null,
  }));
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
export async function peerCredentialForRequest(ownerUserId: string | null, requestUrl: string) {
  const wanted = keyUrl(requestUrl);
  const matches = (base: string) => wanted === base || wanted.startsWith(`${base}/`) || wanted.startsWith(`${base}?`);
  let best: { url: string; peerKey: string; peerFp: string | null } | null = null;
  let bestLen = 0;
  for (const credential of await outboundPeerKeys(ownerUserId)) {
    const base = keyUrl(credential.url);
    if (!base || base.length < bestLen) continue;
    if (matches(base)) {
      best = credential;
      bestLen = base.length;
    }
  }
  if (!best?.peerKey) return null;
  const matchingTargets = (await resolveTargetsFor(ownerUserId)).filter((target) => matches(keyUrl(target.url)));
  const targetLength = Math.max(0, ...matchingTargets.map((target) => keyUrl(target.url).length));
  const expectedFps = matchingTargets
    .filter((target) => target.peerFp && keyUrl(target.url).length === targetLength).map((target) => target.peerFp!);
  return { ...best, expectedFps };
}

/** 读取保存值；真正传输前的身份核对在 peerUserKeyHeader 中完成。 */
export async function peerKeyForRequest(ownerUserId: string | null, requestUrl: string): Promise<string> {
  return (await peerCredentialForRequest(ownerUserId, requestUrl))?.peerKey ?? "";
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

export async function saveVerifiedTargetAddress(
  actor: Actor,
  source: { name: string; url: string; peerFp: string },
  previousUrls: readonly string[] = [],
): Promise<void> {
  const multi = await isMultiUser();
  const owner = ownerIdOf(actor);
  if (multi && !owner) throw new HandoffError("请先登录", 401);
  const samePeer = (target: { peerFp?: string | null }) => !!target.peerFp && sameFingerprint(target.peerFp, source.peerFp);
  const mergedTarget = (target: { url: string; peerFp?: string | null }) => samePeer(target) || sameUrl(target.url, source.url);
  await db.transaction(async (tx) => {
    const before = multi ? [] : (await getAppSettings(tx)).handoffTargets;
    const localKeys = multi ? [] : await tx.select().from(handoffLocalPeerKeys);
    const keys = new Map(localKeys.map((row) => [row.url, row.peerKey]));
    const targets: ResolvedTarget[] = multi
      ? await tx.select().from(userHandoffTargets).where(eq(userHandoffTargets.userId, owner!))
      : before.map((target) => ({ ...target, peerKey: keys.get(keyUrl(target.url)) ?? "" }));
    if (targets.some((target) => sameUrl(target.url, source.url) && target.peerFp && !samePeer(target))) {
      throw new HandoffError("这个地址已登记为另一台机器，请先检查接力目标机设置；原地址未修改。", 409);
    }
    const merged = targets.filter(mergedTarget);
    const previous = merged.find(samePeer) ?? merged[0];
    // 弹窗补填的 key 可以没有目标机行；历史 URL 上现有目标行则可能属于后来占用旧 IP 的机器。
    // 新地址刚通过签名核对；历史地址上的每条目标记录也参与归属冲突检查。
    const credentialUrls = new Set([
      keyUrl(source.url), ...merged.map((target) => keyUrl(target.url)), ...previousUrls.map(keyUrl),
    ].filter(Boolean));
    const conflictingTarget = targets.find((target) => !sameUrl(target.url, source.url)
      && credentialUrls.has(keyUrl(target.url)) && !samePeer(target));
    if (conflictingTarget) {
      throw new HandoffError(
        `旧地址 ${conflictingTarget.url} 的目标机归属冲突，无法确认其属于同一来源机器。原地址和账号 key 未修改。`
        + "请在「设置 → 默认规则 → 任务接力」核对该目标机的地址和身份后重试。",
        409,
      );
    }
    // 任务 marker 和目标行说明地址历史，不能替没有归属证明的账号 key 背书。
    const conflictingKey = localKeys.find((row) => credentialUrls.has(row.url) && row.peerKey
      && (!row.peerFp || !sameFingerprint(row.peerFp, source.peerFp)))
      ?? (multi ? merged.find((target) => target.peerKey && !sameFingerprint(target.peerKeyFp, source.peerFp)) : undefined);
    if (conflictingKey) {
      throw new HandoffError(
        `地址 ${conflictingKey.url} 的账号 key 归属冲突，未确认属于这台来源机器；原地址和 key 未修改。`
        + `请在「设置 → 默认规则 → 任务接力 → ${multi ? "我的接力目标机" : "接力目标机器"}」找到或添加这个地址，确认旧 key 不再使用后清除，再重试。`,
        409,
      );
    }
    const credentials = new Set([
      ...merged.map((target) => target.peerKey), ...[...credentialUrls].map((url) => keys.get(url) ?? ""),
    ].filter(Boolean));
    if (credentials.size > 1) {
      throw new HandoffError("新旧地址配置了不同的账号 key，原地址未修改。请在「设置 → 默认规则 → 任务接力」统一或清空不再使用的 key 后重试。", 409);
    }
    const peerKey = [...credentials][0] ?? "";
    if (multi) {
      if (previous?.id) {
        await tx.update(userHandoffTargets).set({ url: source.url, peerFp: source.peerFp, peerKey, peerKeyFp: peerKey ? source.peerFp : null })
          .where(and(eq(userHandoffTargets.id, previous.id), eq(userHandoffTargets.userId, owner!)));
        const duplicates = merged.filter((target) => target.id !== previous.id).map((target) => target.id!);
        if (duplicates.length) await tx.delete(userHandoffTargets)
          .where(and(eq(userHandoffTargets.userId, owner!), inArray(userHandoffTargets.id, duplicates)));
      } else {
        await tx.insert(userHandoffTargets).values({ id: id(), userId: owner!, ...source, peerKey, peerKeyFp: peerKey ? source.peerFp : null, createdAt: now() });
      }
      return;
    }
    const updated = [...before.filter((target) => !mergedTarget(target)), { ...source, name: previous?.name ?? source.name }];
    try { parseAppSettingsPatch({ handoffTargets: updated }); }
    catch { throw new HandoffError("接力目标机设置无法保存，请检查名称、地址或目标机数量；原地址未修改。", 409); }
    const value = JSON.stringify(updated);
    await tx.insert(appSettings).values({ key: "handoffTargets", value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value } });
    if (peerKey) await tx.insert(handoffLocalPeerKeys).values({ url: keyUrl(source.url), peerKey, peerFp: source.peerFp, updatedAt: now() })
      .onConflictDoUpdate({ target: handoffLocalPeerKeys.url, set: { peerKey, peerFp: source.peerFp, updatedAt: now() } });
    const obsoleteUrls = [...credentialUrls].filter((url) => url !== keyUrl(source.url));
    if (obsoleteUrls.length) await tx.delete(handoffLocalPeerKeys).where(inArray(handoffLocalPeerKeys.url, obsoleteUrls));
  });
  if (!multi) await invalidateInstanceCache();
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
  const multi = await isMultiUser();
  if (multi && !owner) throw new HandoffError("请先登录", 401);
  const peerKeyFp = await keyFingerprintForSave(input.url, input.peerKey ?? "");
  if (!multi) {
    await db.transaction(async (tx) => {
      const { handoffTargets } = await getAppSettings(tx);
      await writeAppSettingsPatch({
        handoffTargets: [...handoffTargets, { name: input.name, url: input.url, peerFp: null }],
      }, tx);
      // 清单和 key 分表保存，但同一次添加只在两者都写入成功后提交。
      if (input.peerKey) await writeLocalPeerKey(tx, keyUrl(input.url), input.peerKey, peerKeyFp);
    });
    await invalidateInstanceCache();
    return listTargets(actor);
  }
  await db.insert(userHandoffTargets).values({
    id: id(),
    userId: owner!,
    name: input.name,
    url: input.url,
    peerFp: null,
    peerKey: input.peerKey ?? "",
    peerKeyFp,
    createdAt: now(),
  });
  return listTargets(actor);
}

async function keyFingerprintForSave(rawUrl: string, peerKey: string, expectedPeerFp?: string | null): Promise<string | null> {
  if (peerKey.length > 512) throw new HandoffError("这把 key 太长了(上限 512 字符)", 400);
  if (expectedPeerFp != null && (typeof expectedPeerFp !== "string" || !/^[a-f0-9]{64}$/i.test(expectedPeerFp))) {
    throw new HandoffError("机器指纹格式无效", 400);
  }
  // 保存新 key 的显式动作绑定当时签名确认的机器，覆盖写不会继承上一把 key 的归属。
  const { probeSignedPeerFingerprint } = await import("../handoff-peer-client.js");
  const peerFp = peerKey ? await probeSignedPeerFingerprint(rawUrl) : null;
  if (peerKey && (!peerFp || (expectedPeerFp && !sameFingerprint(peerFp, expectedPeerFp)))) {
    throw new HandoffError(peerFp
      ? "地址背后的机器指纹不一致，账号 key 未保存。请先核对来源机器地址。"
      : "无法核对机器身份，账号 key 未保存。请确认地址和 ash 运行状态后重试。", peerFp ? 409 : 502);
  }
  return peerFp;
}

async function writeLocalPeerKey(
  connection: Pick<typeof db, "insert" | "delete">, url: string, peerKey: string, peerFp: string | null,
): Promise<void> {
  if (peerKey) {
    await connection.insert(handoffLocalPeerKeys).values({ url, peerKey, peerFp, updatedAt: now() })
      .onConflictDoUpdate({
        target: handoffLocalPeerKeys.url,
        set: { peerKey, peerFp, updatedAt: now() },
      });
  } else {
    await connection.delete(handoffLocalPeerKeys).where(eq(handoffLocalPeerKeys.url, url));
  }
}

/**
 * 按**地址**写「我在对端的账号 key」。两种模式共用这一个入口,理由是调用点手上只有
 * 地址:接力对话框里选的是一台目标机(自用模式那份清单根本没有行 id),预检失败时要
 * 当场能补 key。多人模式落到这个人的那几行,自用模式落到 handoff_local_peer_keys。
 *
 * 空串 = 明确清空(对端转回单人实例了)。
 */
export async function setPeerKey(
  actor: Actor, rawUrl: string, peerKey: string, expectedPeerFp?: string | null,
): Promise<HandoffTarget[]> {
  const url = keyUrl(rawUrl);
  if (!url) throw new HandoffError("缺目标机地址", 400);
  const multi = await isMultiUser();
  const owner = ownerIdOf(actor);
  if (multi && !owner) throw new HandoffError("请先登录", 401);
  const rows = multi
    ? (await db.select().from(userHandoffTargets).where(eq(userHandoffTargets.userId, owner!)))
      .filter((row) => sameUrl(row.url, url))
    : [];
  if (multi && !rows.length) {
    throw new HandoffError("先把这台目标机加进「我的接力目标机」,再给它配 key", 404);
  }
  const peerFp = await keyFingerprintForSave(rawUrl, peerKey, expectedPeerFp);
  if (!multi) {
    // 不校验「这个地址还在不在清单里」是**故意的**:pending 重放收口时,弹框会为
    // 「已从设置里删掉、但任务还挂在它身上」的地址合成一个目标,那里填的 key 必须真的
    // 能用。出站读侧直接读这张表,所以写下去就生效(见 `outboundPeerKeys`)。
    await writeLocalPeerKey(db, url, peerKey, peerFp);
    return listTargets(actor);
  }
  // 同一个地址被登记了两行时一起写:「我在那台机器上的 key」只可能是同一把。
  await db.update(userHandoffTargets).set({ peerKey, peerKeyFp: peerFp })
    .where(inArray(userHandoffTargets.id, rows.map((row) => row.id)));
  return listTargets(actor);
}

/**
 * 自用模式:目标机从设置里被删掉后,顺手把它那把 key 也删了。留着不会泄露(出站要先
 * 拿到地址才用得上),但「删掉再加回同一个地址,旧 key 悄悄复活」是会让人查半天的意外
 * 行为。由 `patchSettingsFor` 在更新 handoffTargets 的同一事务中调用。
 *
 * 入参是**改动前后的两份清单**,删的只有「这次被拿掉的那几个地址」。早先那版收的是
 * 「留下来的地址」、把一切对不上的行都当孤儿删掉,会连带清掉**故意为不在清单里的地址
 * 配的 key**(pending 重放那种):用户配完当场能用,随手改一下别的目标机就又不能用了。
 */
export async function forgetRemovedPeerKeys(
  before: readonly { url: string }[],
  after: readonly { url: string }[],
  connection: Pick<typeof db, "delete">,
): Promise<void> {
  const kept = new Set(after.map((t) => keyUrl(t.url)));
  const removed = [...new Set(before.map((t) => keyUrl(t.url)))].filter((url) => !kept.has(url));
  if (removed.length) {
    await connection.delete(handoffLocalPeerKeys).where(inArray(handoffLocalPeerKeys.url, removed));
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
  if (patch.peerKey !== undefined) {
    const target = (await db.select().from(userHandoffTargets)
      .where(and(eq(userHandoffTargets.id, targetId), eq(userHandoffTargets.userId, owner)))).at(0);
    if (!target) throw new HandoffError("目标机不存在", 404);
    set.peerKey = patch.peerKey;
    set.peerKeyFp = await keyFingerprintForSave(patch.url ?? target.url, patch.peerKey, patch.peerFp ?? (patch.url ? null : target.peerFp));
  }
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
