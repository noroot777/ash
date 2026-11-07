// 飞书身份 ↔ ash 身份的绑定。
//
// 三步，每一步都留在库里（刷新页面能看出走到了哪一步）：
//   ① 网页上点「生成绑定码」→ 一次性码，10 分钟有效，库里只存哈希；
//   ② 在飞书里把码发给机器人（单聊）→ 认领：记下是哪个飞书账号发来的；
//   ③ 回到网页点「确认」→ 绑定生效。
// 为什么不在第②步就生效：码是明文显示在屏幕上的，被人看到、转发、截图都有可能；第②步只
// 说明「有人在飞书里发了这串码」，要回到登录着的网页上再点一下，才说明是本人。
//
// 群绑定（码在群里 @ 机器人发出）走同一张表、同一套三步，细节在 ./groups.ts。群码只认
// **生成它的那个人自己**在群里发出来的：先要绑好个人飞书，群里发码的飞书账号必须就是绑定的
// 那一个 —— 这样「这个群里有我」是被证明过的，而不是谁把码转进哪个群都能绑。
import { createHash, randomInt } from "node:crypto";
import type { FeishuBinding, ImBindCode } from "@ash/shared";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { imBindCodes, imBindings } from "../db/schema-im.js";
import { id, now } from "../util.js";

export const CHANNEL = "feishu" as const;
export const BIND_CODE_TTL_MS = 10 * 60_000;

// 去掉 0/O、1/I/L 这几个看错就输错的字符。8 位 × 32 种 ≈ 1.1e12，10 分钟内猜不中。
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_RE = /ASH[\s-]*([A-Z0-9]{4})[\s-]*([A-Z0-9]{4})/i;

export type BindPurpose = "user" | "group";
export type CodeRow = typeof imBindCodes.$inferSelect;
export type BindingRow = typeof imBindings.$inferSelect;

/** 自用模式的「账号」统一记成空串（见 schema-im.ts 里 owner 列的注释）。 */
export function ownerKeyOf(userId: string | null): string {
  return userId ?? "";
}

function hashCode(core: string): string {
  return createHash("sha256").update(`ash-im-bind:${core.toUpperCase()}`).digest("hex");
}

function mintCore(): string {
  let out = "";
  for (let i = 0; i < 8; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** 从一条消息里认出绑定码（容忍空格、小写、少打连字符）。没有返回 null。 */
export function extractCode(text: string): string | null {
  const match = CODE_RE.exec(text);
  return match ? `${match[1]}${match[2]}`.toUpperCase() : null;
}

export const openIdTail = (openId: string) => openId.slice(-6);

const isLive = (row: CodeRow, at = Date.now()) =>
  (row.state === "open" || row.state === "claimed") && Date.parse(row.expiresAt) > at;

/**
 * 生成新码。同一个人同一种用途只留一张有效的码：再点一次「生成」，旧码立即作废（不然屏幕上
 * 旧码被人看到过，换一张也没用）。
 */
export async function createBindCode(owner: string, purpose: BindPurpose, projectId: string | null): Promise<ImBindCode> {
  const core = mintCore();
  const createdAt = now();
  const expiresAt = new Date(Date.now() + BIND_CODE_TTL_MS).toISOString();
  const row = { id: id(), owner, purpose, projectId, codeHash: hashCode(core), state: "open", createdAt, expiresAt };
  await db.transaction(async (tx) => {
    await tx.update(imBindCodes).set({ state: "rejected" }).where(and(
      eq(imBindCodes.owner, owner), eq(imBindCodes.purpose, purpose), inArray(imBindCodes.state, ["open", "claimed"]),
    ));
    await tx.insert(imBindCodes).values(row);
  });
  return { codeId: row.id, code: `ASH-${core.slice(0, 4)}-${core.slice(4)}`, expiresAt };
}

export type ClaimInput = {
  appId: string;
  openId: string;
  chatId: string;
  chatType: "p2p" | "group";
  /** 群名（群绑定时由调用方查好传进来）。 */
  name?: string | null;
};

export type ClaimResult =
  | { kind: "claimed"; purpose: BindPurpose; codeId: string }
  | { kind: "unknown" }
  | { kind: "expired" }
  /** 个人码发到了群里、群码发到了单聊。 */
  | { kind: "wrong_place"; purpose: BindPurpose }
  /** 已经被另一个飞书账号 / 另一个群认领过。 */
  | { kind: "taken" }
  /** 群码不是生成它的那个人自己发的。 */
  | { kind: "not_owner" };

/** 飞书侧收到一串码：认领它。只认领、不生效。 */
export async function claimCode(core: string, input: ClaimInput): Promise<ClaimResult> {
  const row = (await db.select().from(imBindCodes).where(eq(imBindCodes.codeHash, hashCode(core)))
    .orderBy(desc(imBindCodes.createdAt))).at(0);
  if (!row || row.state === "rejected" || row.state === "confirmed") return { kind: "unknown" };
  if (!isLive(row)) return { kind: "expired" };
  const purpose = row.purpose === "group" ? "group" : "user";
  if ((purpose === "user") !== (input.chatType === "p2p")) return { kind: "wrong_place", purpose };
  if (purpose === "group") {
    const sender = await bindingOf(input.appId, input.openId);
    if (!sender || ownerKeyOf(sender.userId) !== row.owner) return { kind: "not_owner" };
  }
  if (row.state === "claimed") {
    const same = row.claimedAppId === input.appId
      && (purpose === "user" ? row.claimedOpenId === input.openId : row.claimedChatId === input.chatId);
    return same ? { kind: "claimed", purpose, codeId: row.id } : { kind: "taken" };
  }
  // 条件写：两条消息同时带着这串码进来，只有一条认领得到。
  const claimed = await db.update(imBindCodes).set({
    state: "claimed",
    claimedAppId: input.appId,
    claimedOpenId: input.openId,
    claimedChatId: input.chatId,
    claimedName: input.name ?? null,
    claimedAt: now(),
  }).where(and(eq(imBindCodes.id, row.id), eq(imBindCodes.state, "open"))).returning({ id: imBindCodes.id });
  if (!claimed.length) return claimCode(core, input);
  return { kind: "claimed", purpose, codeId: row.id };
}

/** 本人此刻有效的那张码（未过期、没确认没拒绝）。 */
export async function liveCodeOf(owner: string, purpose: BindPurpose, codeId?: string): Promise<CodeRow | null> {
  const rows = await db.select().from(imBindCodes).where(and(
    eq(imBindCodes.owner, owner), eq(imBindCodes.purpose, purpose),
    ...(codeId ? [eq(imBindCodes.id, codeId)] : []),
  )).orderBy(desc(imBindCodes.createdAt));
  return rows.find((row) => isLive(row)) ?? null;
}

export async function rejectCode(owner: string, purpose: BindPurpose, codeId: string): Promise<boolean> {
  const rows = await db.update(imBindCodes).set({ state: "rejected" }).where(and(
    eq(imBindCodes.id, codeId), eq(imBindCodes.owner, owner), eq(imBindCodes.purpose, purpose),
    inArray(imBindCodes.state, ["open", "claimed"]),
  )).returning({ id: imBindCodes.id });
  return rows.length > 0;
}

/** 本人的绑定（不限应用：换了应用的旧绑定也要能看见，好提示「需要重新绑定」）。 */
export async function bindingOfOwner(owner: string): Promise<BindingRow | null> {
  const rows = await db.select().from(imBindings).where(and(
    eq(imBindings.channel, CHANNEL),
    owner ? eq(imBindings.userId, owner) : isNull(imBindings.userId),
  )).orderBy(desc(imBindings.boundAt));
  return rows.at(0) ?? null;
}

export async function bindingOf(appId: string, openId: string): Promise<BindingRow | null> {
  return (await db.select().from(imBindings).where(and(
    eq(imBindings.channel, CHANNEL), eq(imBindings.appId, appId), eq(imBindings.openId, openId),
  ))).at(0) ?? null;
}

/** 当前应用下的全部绑定（推送按它找收件人）。 */
export async function bindingsOfApp(appId: string): Promise<BindingRow[]> {
  return db.select().from(imBindings).where(and(eq(imBindings.channel, CHANNEL), eq(imBindings.appId, appId)));
}

export async function bindingView(owner: string, currentAppId: string | null): Promise<FeishuBinding> {
  const code = await liveCodeOf(owner, "user");
  if (code?.state === "claimed" && code.claimedOpenId && code.claimedAt) {
    return { state: "pending", codeId: code.id, openIdTail: openIdTail(code.claimedOpenId), claimedAt: code.claimedAt, expiresAt: code.expiresAt };
  }
  if (code) return { state: "code", codeId: code.id, expiresAt: code.expiresAt };
  const binding = await bindingOfOwner(owner);
  if (!binding) return { state: "none" };
  return {
    state: "bound",
    appId: binding.appId,
    openIdTail: openIdTail(binding.openId),
    boundAt: binding.boundAt,
    stale: binding.appId !== currentAppId,
    projectId: binding.projectId,
  };
}

export type ConfirmResult =
  | { ok: true; binding: BindingRow }
  | { ok: false; error: string };

/**
 * 网页上点「确认」。一个 ash 账号只绑一个飞书账号，一个飞书账号也只对应一个 ash 账号：
 * 确认时把两头的旧绑定都摘掉（换手机号、换应用重绑都走这里）。
 */
export async function confirmUserCode(owner: string, codeId: string, currentAppId: string | null): Promise<ConfirmResult> {
  const code = await liveCodeOf(owner, "user", codeId);
  if (!code) return { ok: false, error: "这张绑定码已过期或已作废，请重新生成" };
  if (code.state !== "claimed" || !code.claimedOpenId || !code.claimedAppId) {
    return { ok: false, error: "还没在飞书里收到这串码：请先在飞书里把它发给机器人" };
  }
  if (code.claimedAppId !== currentAppId) return { ok: false, error: "认领时用的飞书应用已经换掉了，请重新生成绑定码" };
  const previous = await bindingOfOwner(owner);
  const binding: BindingRow = {
    channel: CHANNEL,
    appId: code.claimedAppId,
    openId: code.claimedOpenId,
    userId: owner || null,
    chatId: code.claimedChatId,
    // 换绑同一个飞书账号时沿用原来的助手房间与当前项目。
    assistantRoomId: previous?.openId === code.claimedOpenId ? previous.assistantRoomId : null,
    projectId: previous?.projectId ?? null,
    boundAt: now(),
  };
  const done = await db.transaction(async (tx) => {
    const flipped = await tx.update(imBindCodes).set({ state: "confirmed" })
      .where(and(eq(imBindCodes.id, code.id), eq(imBindCodes.state, "claimed"))).returning({ id: imBindCodes.id });
    if (!flipped.length) return false;
    await tx.delete(imBindings).where(and(eq(imBindings.channel, CHANNEL), or(
      owner ? eq(imBindings.userId, owner) : isNull(imBindings.userId),
      and(eq(imBindings.appId, binding.appId), eq(imBindings.openId, binding.openId)),
    )));
    await tx.insert(imBindings).values(binding);
    return true;
  });
  return done ? { ok: true, binding } : { ok: false, error: "这张绑定码刚刚已被处理过，请刷新" };
}

export async function unbindOwner(owner: string): Promise<BindingRow | null> {
  const binding = await bindingOfOwner(owner);
  await db.delete(imBindings).where(and(
    eq(imBindings.channel, CHANNEL), owner ? eq(imBindings.userId, owner) : isNull(imBindings.userId),
  ));
  return binding;
}

/**
 * 领这个人的助手房间（relay.ts assistantRoom），判据同 groups.ts claimGroupRoom：绑定还是入口读到的那一次、
 * 记着的还是读到的那一间（或者还没有）才换成新建的这间，否则认已经记上的那间；换过绑定返回 null。
 */
export async function claimAssistantRoom(
  key: { appId: string; openId: string }, boundAt: string, expected: string | null, roomId: string,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const where = and(eq(imBindings.channel, CHANNEL), eq(imBindings.appId, key.appId), eq(imBindings.openId, key.openId));
    const binding = (await tx.select().from(imBindings).where(where)).at(0);
    if (binding?.boundAt !== boundAt) return null;
    if (binding.assistantRoomId && binding.assistantRoomId !== expected) return binding.assistantRoomId;
    await tx.update(imBindings).set({ assistantRoomId: roomId }).where(where);
    return roomId;
  }, { behavior: "immediate" });
}

/** boundAt = 只改这一次绑定（替某一次请求改的：中途换了绑就不改，返回 false）。 */
export async function updateBinding(
  key: { appId: string; openId: string },
  patch: Partial<Pick<BindingRow, "chatId" | "assistantRoomId" | "projectId">>,
  boundAt?: string,
): Promise<boolean> {
  const updated = await db.update(imBindings).set(patch).where(and(
    eq(imBindings.channel, CHANNEL), eq(imBindings.appId, key.appId), eq(imBindings.openId, key.openId),
    ...(boundAt === undefined ? [] : [eq(imBindings.boundAt, boundAt)]),
  )).returning({ openId: imBindings.openId });
  return updated.length > 0;
}
