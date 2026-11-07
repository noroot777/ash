// 群 ↔ 项目的绑定。
//
// 绑法与个人绑定同一套三步（见 ./binding.ts 顶部）：网页上选好项目生成码 → 在群里 @ 机器人
// 发出这串码 → 回网页确认。绑上之后：
//   · 群里 @ 机器人的话进这个项目的群聊房间（每个说话人各自一间，见 schema-im.ts 的
//     im_group_rooms）。说话人必须自己绑定过 ash，否则不处理 —— 群里的人不一定都是 ash 用户，
//     不能让他们借绑群那个人的身份派活。
//   · 打开「卡片推到群里」后，这个项目任务的决策卡改发到群里（话题里回复 = 回复任务），
//     不再发到各人单聊。群卡片上的按钮按**点击人自己的绑定**执行，权限照他本人的算。
import type { FeishuGroup, FeishuGroupClaim, FeishuGroups } from "@ash/shared";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { imBindCodes, imGroupRooms, imGroups } from "../db/schema-im.js";
import { users } from "../db/schema-multiuser.js";
import { now } from "../util.js";
import { bindingOfOwner, CHANNEL, liveCodeOf } from "./binding.js";

export type GroupRow = typeof imGroups.$inferSelect;

export async function groupOf(appId: string, chatId: string): Promise<GroupRow | null> {
  return (await db.select().from(imGroups).where(and(
    eq(imGroups.channel, CHANNEL), eq(imGroups.appId, appId), eq(imGroups.chatId, chatId),
  ))).at(0) ?? null;
}

export async function groupsOfApp(appId: string): Promise<GroupRow[]> {
  return db.select().from(imGroups).where(and(eq(imGroups.channel, CHANNEL), eq(imGroups.appId, appId)))
    .orderBy(desc(imGroups.boundAt));
}

/** 这个项目的卡片该推到哪个群（打开了「卡片推到群里」的那个；绑了好几个取最近绑的）。groups 按绑定时间倒序。 */
const receiverOf = (groups: GroupRow[], projectId: string) =>
  groups.find((group) => group.projectId === projectId && group.pushCards === 1) ?? null;

export async function pushGroupOf(appId: string, projectId: string): Promise<GroupRow | null> {
  return receiverOf(await groupsOfApp(appId), projectId);
}

async function namesOf(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.name }).from(users);
  return new Map(rows.filter((row) => ids.includes(row.id)).map((row) => [row.id, row.name]));
}

/** 改/解绑群的资格：绑它的人本人，或实例管理员（routes.ts 的接口按同一条拦）。 */
export const canEditGroup = (group: GroupRow, owner: string, admin: boolean) => admin || (group.boundBy ?? "") === owner;

/**
 * 还是不是同一次绑定：比 boundAt + boundBy（改项目、开关推卡都不换这两样）。重绑会换 boundAt，换了人 boundBy 也跟着换；
 * 改 / 解绑的资格只看绑的人（canEditGroup），所以同一毫秒里重绑撞上同一个 boundAt 时，只要人没换，原来那份判断照样成立。
 *
 * 为什么写入时要核这个：改 / 解绑 / 覆盖的资格是对着**读到的那一份**判的（canEditGroup），判完到真写之间隔着
 * 好几次 await。这期间别人把群绑走了、改绑了、解绑了，那份判断就不作数了 —— 不核的话两个人同时确认同一个群，
 * 两边都通过「群还没人绑」那道检查，后提交的那个无条件覆盖掉前一个刚绑好的（审查实测）。所以三个写入口都在
 * 同一个事务里先核「此刻的绑定还是授权时那一份」，对不上就整笔不写：码不翻、群聊房间映射不清。
 */
const sameBinding = (a: GroupRow | null, b: GroupRow | null) =>
  a === null || b === null ? a === b : a.boundAt === b.boundAt && (a.boundBy ?? null) === (b.boundBy ?? null);

export const GROUP_CHANGED = "这个群的绑定刚刚变了（别人刚绑上、改过或解绑了），请刷新后按现在的样子再操作";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const groupIn = async (tx: Tx, appId: string, chatId: string): Promise<GroupRow | null> =>
  (await tx.select().from(imGroups).where(and(eq(imGroups.channel, CHANNEL), eq(imGroups.appId, appId), eq(imGroups.chatId, chatId)))).at(0) ?? null;

/**
 * 网页上的群列表。`visible` 为 null = 不设限（自用模式 / 管理员），否则只列这些项目的群。
 * claims 只列本人发起、还没确认的那张群码。
 */
export async function groupsView(owner: string, admin: boolean, appId: string | null, visible: Set<string> | null): Promise<FeishuGroups> {
  const all = appId ? await groupsOfApp(appId) : [];
  const rows = all.filter((row) => visible === null || visible.has(row.projectId));
  const names = await namesOf(rows.flatMap((row) => row.boundBy ? [row.boundBy] : []));
  const groups: FeishuGroup[] = rows.map((row) => ({
    chatId: row.chatId,
    name: row.name,
    projectId: row.projectId,
    boundAt: row.boundAt,
    pushCards: row.pushCards === 1,
    receiving: receiverOf(all, row.projectId)?.chatId === row.chatId,
    boundBy: row.boundBy ? names.get(row.boundBy) ?? null : null,
    canEdit: canEditGroup(row, owner, admin),
  }));
  const code = await liveCodeOf(owner, "group");
  const claims: FeishuGroupClaim[] = code && code.projectId ? [{
    codeId: code.id,
    projectId: code.projectId,
    chatId: code.state === "claimed" ? code.claimedChatId : null,
    name: code.state === "claimed" ? code.claimedName : null,
    claimedAt: code.state === "claimed" ? code.claimedAt : null,
    expiresAt: code.expiresAt,
  }] : [];
  return { groups, claims };
}

export type GroupConfirm = { ok: true; group: GroupRow } | { ok: false; error: string; status?: 403 | 409 };

/** 确认那一刻确认人的权限（由路由按当前登录身份现算）。 */
export interface GroupConfirmAuthz {
  canSeeProject: (projectId: string) => Promise<boolean>;
  admin: boolean;
}

/**
 * 网页上确认群绑定。生成码到确认之间可能隔了好几分钟，那时核过的都要按此刻重核一遍：
 * 还能不能看见这个项目、本人的飞书绑定还是不是认领时发码的那个账号。同一个群重绑到别的项目
 * = 覆盖（群聊房间随之换掉）；那个群原来是别人绑的，只有实例管理员能覆盖（与改 / 解绑同一道闸）。
 * 「原来是谁绑的」在写入的事务里再核一次（sameBinding）：两个人同时确认同一个群，只有先提交的那个算数。
 */
export async function confirmGroupCode(
  owner: string, codeId: string, currentAppId: string | null, authz: GroupConfirmAuthz,
): Promise<GroupConfirm> {
  const code = await liveCodeOf(owner, "group", codeId);
  if (!code || !code.projectId) return { ok: false, error: "这张群绑定码已过期或已作废，请重新生成" };
  if (code.state !== "claimed" || !code.claimedChatId || !code.claimedAppId) {
    return { ok: false, error: "还没在群里收到这串码：请在群里 @ 机器人把它发出去" };
  }
  if (code.claimedAppId !== currentAppId) return { ok: false, error: "认领时用的飞书应用已经换掉了，请重新生成绑定码" };
  if (!await authz.canSeeProject(code.projectId)) return { ok: false, status: 403, error: "你已经看不到这个项目了，不能把群绑到它上面" };
  const mine = await bindingOfOwner(owner);
  if (!mine || mine.appId !== currentAppId || mine.openId !== code.claimedOpenId) {
    return { ok: false, error: "你的飞书绑定在认领之后变了：请重新生成群绑定码，用现在绑定的飞书账号在群里发" };
  }
  const existing = await groupOf(code.claimedAppId, code.claimedChatId);
  if (existing && (existing.boundBy ?? "") !== owner && !authz.admin) {
    return { ok: false, status: 403, error: "这个群已经被别人绑到了项目上，只有他本人或实例管理员能改" };
  }
  const group: GroupRow = {
    channel: CHANNEL,
    appId: code.claimedAppId,
    chatId: code.claimedChatId,
    projectId: code.projectId,
    name: code.claimedName,
    boundBy: owner || null,
    pushCards: 0,
    boundAt: now(),
  };
  const done = await db.transaction(async (tx) => {
    if (!sameBinding(await groupIn(tx, group.appId, group.chatId), existing)) return "changed";
    const flipped = await tx.update(imBindCodes).set({ state: "confirmed" })
      .where(and(eq(imBindCodes.id, code.id), eq(imBindCodes.state, "claimed"))).returning({ id: imBindCodes.id });
    if (!flipped.length) return "handled";
    await tx.delete(imGroups).where(and(eq(imGroups.channel, CHANNEL), eq(imGroups.appId, group.appId), eq(imGroups.chatId, group.chatId)));
    await tx.delete(imGroupRooms).where(and(eq(imGroupRooms.channel, CHANNEL), eq(imGroupRooms.appId, group.appId), eq(imGroupRooms.chatId, group.chatId)));
    await tx.insert(imGroups).values(group);
    return "done";
  }, { behavior: "immediate" });
  if (done === "changed") return { ok: false, status: 409, error: GROUP_CHANGED };
  return done === "done" ? { ok: true, group } : { ok: false, error: "这张群绑定码刚刚已被处理过，请刷新" };
}

/**
 * 改群（换项目 / 开关推卡）。`authorized` = 判过改的资格的那一份（routes.ts editableGroup 读到的）；false = 这期间
 * 群的绑定换过了（sameBinding），什么都没改。
 */
export async function patchGroup(authorized: GroupRow, patch: { projectId?: string; pushCards?: boolean }): Promise<boolean> {
  const { appId, chatId } = authorized;
  const set: Partial<GroupRow> = {};
  if (patch.projectId !== undefined) set.projectId = patch.projectId;
  if (patch.pushCards !== undefined) set.pushCards = patch.pushCards ? 1 : 0;
  if (!Object.keys(set).length) return true;
  return db.transaction(async (tx) => {
    if (!sameBinding(await groupIn(tx, appId, chatId), authorized)) return false;
    await tx.update(imGroups).set(set).where(and(eq(imGroups.channel, CHANNEL), eq(imGroups.appId, appId), eq(imGroups.chatId, chatId)));
    // 换了项目：旧项目的群聊房间不再对应这个群。
    if (patch.projectId !== undefined) {
      await tx.delete(imGroupRooms).where(and(eq(imGroupRooms.channel, CHANNEL), eq(imGroupRooms.appId, appId), eq(imGroupRooms.chatId, chatId)));
    }
    return true;
  }, { behavior: "immediate" });
}

/** 解绑群。`authorized` 同 patchGroup；false = 这期间群的绑定换过了，新的那份原样留着。 */
export async function deleteGroup(authorized: GroupRow): Promise<boolean> {
  const { appId, chatId } = authorized;
  return db.transaction(async (tx) => {
    if (!sameBinding(await groupIn(tx, appId, chatId), authorized)) return false;
    await tx.delete(imGroups).where(and(eq(imGroups.channel, CHANNEL), eq(imGroups.appId, appId), eq(imGroups.chatId, chatId)));
    await tx.delete(imGroupRooms).where(and(eq(imGroupRooms.channel, CHANNEL), eq(imGroupRooms.appId, appId), eq(imGroupRooms.chatId, chatId)));
    return true;
  }, { behavior: "immediate" });
}

export async function groupRoomOf(appId: string, chatId: string, userKey: string): Promise<string | null> {
  return (await db.select({ roomId: imGroupRooms.roomId }).from(imGroupRooms).where(and(
    eq(imGroupRooms.channel, CHANNEL), eq(imGroupRooms.appId, appId), eq(imGroupRooms.chatId, chatId), eq(imGroupRooms.userKey, userKey),
  ))).at(0)?.roomId ?? null;
}

/**
 * 领这个人在这个群里的那一间（relay.ts groupRoom）：映射还是入口读到的那一间（或者还没有）才换成新建的
 * 这间；别处已经领到了就认那一间 —— 出口只放行映射上的那一间（scope.ts），各领各的，没领到的那间的回复
 * 就永远发不出去。群这期间解绑重绑过、换过项目（入口读到的那一次绑定已经不是现在这样）返回 null：
 * 旧绑定下建的房间不落进新绑定的映射。
 */
export async function claimGroupRoom(group: GroupRow, userKey: string, expected: string | null, roomId: string): Promise<string | null> {
  const { appId, chatId } = group;
  return db.transaction(async (tx) => {
    const bound = (await tx.select({ boundAt: imGroups.boundAt, projectId: imGroups.projectId }).from(imGroups).where(and(
      eq(imGroups.channel, CHANNEL), eq(imGroups.appId, appId), eq(imGroups.chatId, chatId),
    ))).at(0);
    if (bound?.boundAt !== group.boundAt || bound.projectId !== group.projectId) return null;
    const current = (await tx.select({ roomId: imGroupRooms.roomId }).from(imGroupRooms).where(and(
      eq(imGroupRooms.channel, CHANNEL), eq(imGroupRooms.appId, appId), eq(imGroupRooms.chatId, chatId), eq(imGroupRooms.userKey, userKey),
    ))).at(0)?.roomId ?? null;
    if (current !== null && current !== expected) return current;
    await tx.insert(imGroupRooms).values({ channel: CHANNEL, appId, chatId, userKey, roomId })
      .onConflictDoUpdate({ target: [imGroupRooms.channel, imGroupRooms.appId, imGroupRooms.chatId, imGroupRooms.userKey], set: { roomId } });
    return roomId;
  }, { behavior: "immediate" });
}
