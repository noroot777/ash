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

/**
 * 一个已绑的群上，**资格判断读得到的就这几样**：绑它的人（boundBy）、绑在哪个项目（projectId）、是哪一次绑定（boundAt）。
 * canEditGroup / editRefusal 只收这个窄类型，写入口在事务里按同一份清单比对（sameGrant）—— 以后资格要多看一个字段，
 * 得先把它加进这份清单，比对就跟着覆盖到，不会再出现「判的是三样、核的是两样」。
 *
 * 为什么写入时要核：改 / 解绑 / 覆盖的资格是对着**读到的那一份**判的，判完到真写之间隔着好几次 await。这期间别人把群
 * 绑走了、改绑了、换了项目、解绑了，那份判断就不作数了。两轮审查各实测一个：两个人同时确认同一个群，后提交的覆盖了
 * 前一个刚绑好的；管理员把群移到你看不到的项目上，你先前发出的「开推送」照样把新项目的推送打开、解绑照样删掉它。
 * 所以确认、改、解绑、群聊房间认领都在同一个事务里先核「此刻的这几样还是判资格时那一份」，对不上就整笔不写：码不翻、
 * 群聊房间映射不清。
 */
const GRANT_KEYS = ["boundAt", "boundBy", "projectId"] as const;
export type GroupGrant = Pick<GroupRow, (typeof GRANT_KEYS)[number]>;

const sameGrant = (a: GroupGrant | null, b: GroupGrant | null) =>
  a === null || b === null ? a === b : GRANT_KEYS.every((key) => (a[key] ?? null) === (b[key] ?? null));

/** 绑它的人本人，或实例管理员（群列表上的「能不能改」）。只看人；看不看得见项目由 editRefusal 一起算。 */
export const canEditGroup = (group: GroupGrant, owner: string, admin: boolean) => admin || (group.boundBy ?? "") === owner;

/** 谁在改：本人的归属键、是不是实例管理员、此刻看不看得见某个项目（路由按当前登录身份现算）。 */
export interface GroupEditor {
  owner: string;
  admin: boolean;
  canSeeProject: (projectId: string) => Promise<boolean>;
}

/**
 * 改 / 解绑 / 覆盖一个已绑的群的资格，网页的改、解绑接口与确认覆盖共用这一条：看得见它此刻的项目，并且是绑它的人或
 * 实例管理员。null = 可以；hidden = 看不到它的项目（接口按「没有这个群」答，不透露别的项目）；not_binder = 别人绑的。
 */
export async function editRefusal(group: GroupGrant, who: GroupEditor): Promise<"hidden" | "not_binder" | null> {
  if (!await who.canSeeProject(group.projectId)) return "hidden";
  return canEditGroup(group, who.owner, who.admin) ? null : "not_binder";
}

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
export type GroupConfirmAuthz = Omit<GroupEditor, "owner">;

/**
 * 网页上确认群绑定。生成码到确认之间可能隔了好几分钟，那时核过的都要按此刻重核一遍：
 * 还能不能看见这个项目、本人的飞书绑定还是不是认领时发码的那个账号。同一个群重绑到别的项目
 * = 覆盖（群聊房间随之换掉），资格与改 / 解绑同一条（editRefusal）：别人绑的、绑在你看不到的项目上的，都只有实例
 * 管理员能覆盖。判资格读到的那一份在写入的事务里再核一次（sameGrant）：两个人同时确认同一个群，只有先提交的那个算数。
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
  const refusal = existing ? await editRefusal(existing, { owner, ...authz }) : null;
  if (refusal === "not_binder") return { ok: false, status: 403, error: "这个群已经被别人绑到了项目上，只有他本人或实例管理员能改" };
  if (refusal === "hidden") return { ok: false, status: 403, error: "这个群现在绑在你看不到的项目上，只有实例管理员能改" };
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
    if (!sameGrant(await groupIn(tx, group.appId, group.chatId), existing)) return "changed";
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
 * 判资格看的那几样变过了（sameGrant），什么都没改。
 */
export async function patchGroup(authorized: GroupRow, patch: { projectId?: string; pushCards?: boolean }): Promise<boolean> {
  const { appId, chatId } = authorized;
  const set: Partial<GroupRow> = {};
  if (patch.projectId !== undefined) set.projectId = patch.projectId;
  if (patch.pushCards !== undefined) set.pushCards = patch.pushCards ? 1 : 0;
  if (!Object.keys(set).length) return true;
  return db.transaction(async (tx) => {
    if (!sameGrant(await groupIn(tx, appId, chatId), authorized)) return false;
    await tx.update(imGroups).set(set).where(and(eq(imGroups.channel, CHANNEL), eq(imGroups.appId, appId), eq(imGroups.chatId, chatId)));
    // 换了项目：旧项目的群聊房间不再对应这个群。
    if (patch.projectId !== undefined) {
      await tx.delete(imGroupRooms).where(and(eq(imGroupRooms.channel, CHANNEL), eq(imGroupRooms.appId, appId), eq(imGroupRooms.chatId, chatId)));
    }
    return true;
  }, { behavior: "immediate" });
}

/** 解绑群。`authorized` 同 patchGroup；false = 这期间判资格看的那几样变过了，现在那份原样留着。 */
export async function deleteGroup(authorized: GroupRow): Promise<boolean> {
  const { appId, chatId } = authorized;
  return db.transaction(async (tx) => {
    if (!sameGrant(await groupIn(tx, appId, chatId), authorized)) return false;
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
 * 就永远发不出去。群这期间解绑重绑过、换过项目（入口读到的那一份已经不是现在这样，sameGrant）返回 null：
 * 旧绑定下建的房间不落进新绑定的映射。
 */
export async function claimGroupRoom(group: GroupRow, userKey: string, expected: string | null, roomId: string): Promise<string | null> {
  const { appId, chatId } = group;
  return db.transaction(async (tx) => {
    if (!sameGrant(await groupIn(tx, appId, chatId), group)) return null;
    const current = (await tx.select({ roomId: imGroupRooms.roomId }).from(imGroupRooms).where(and(
      eq(imGroupRooms.channel, CHANNEL), eq(imGroupRooms.appId, appId), eq(imGroupRooms.chatId, chatId), eq(imGroupRooms.userKey, userKey),
    ))).at(0)?.roomId ?? null;
    if (current !== null && current !== expected) return current;
    await tx.insert(imGroupRooms).values({ channel: CHANNEL, appId, chatId, userKey, roomId })
      .onConflictDoUpdate({ target: [imGroupRooms.channel, imGroupRooms.appId, imGroupRooms.chatId, imGroupRooms.userKey], set: { roomId } });
    return roomId;
  }, { behavior: "immediate" });
}
