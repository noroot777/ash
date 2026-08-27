// users / user_sessions / user_invites 的读写与 key 哈希。
//
// **key 即身份**:库里只存哈希,明文只在生成那一刻返回一次(§三)。哈希用 scrypt ——
// key 是 256 bit 的高熵随机串,本来就不怕字典攻击,但慢哈希让「库泄露 = 直接拿到所有
// key」这条路也堵上,成本只有登录时的一次 ~50ms。
//
// 登录会话 token 同样只存哈希:库会被 preview-seed 快照、被用户备份来回搬,活会话跟着
// 走就等于身份被复制成两份(理由同 handoff-identity.ts 的私钥不进库)。
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { UserRole, UserStatus, UserView } from "@ash/shared";
import { db } from "../db/index.js";
import { users, userSessions, userInvites } from "../db/schema.js";
import { id, now } from "../util.js";

type UserRow = typeof users.$inferSelect;

/** 会话有效期(天)。滑动:每次带着有效 cookie 来都往后顺延。 */
export const SESSION_DAYS = 30;
/** 专属邀请链接的有效期(天)。§五 定死 7 天。 */
export const INVITE_DAYS = 7;

// ── key 与 token ────────────────────────────────────────────────────────────

/** `ash_` + 43 字符 base64url(256 bit 熵)。前缀让它在聊天记录里一眼可辨。 */
export function mintKey(): string {
  return `ash_${randomBytes(32).toString("base64url")}`;
}

/** 邀请/项目邀请链接里的 token。同样高熵,但不带 `ash_` 前缀 —— 它不是身份。 */
export function mintToken(): string {
  return randomBytes(24).toString("base64url");
}

const SCRYPT_KEYLEN = 32;

export function hashKey(plain: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(plain, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export function verifyKey(plain: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(hashB64, "base64");
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEYLEN) return false;
  const derived = scryptSync(plain, Buffer.from(saltB64, "base64"), SCRYPT_KEYLEN);
  return timingSafeEqual(derived, expected);
}

/**
 * 会话/邀请 token 的索引哈希。这里用**快哈希**而不是 scrypt,是刻意的:
 * 查一条会话要按哈希做等值查询,scrypt 每次盐不同、根本查不了;而 token 是 192 bit
 * 随机串,不存在「猜得出原文」的问题,sha256 足够。
 */
export const tokenDigest = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

// ── 用户 ────────────────────────────────────────────────────────────────────

export const toUserView = (row: UserRow, hasPendingInvite?: boolean): UserView => ({
  id: row.id,
  name: row.name,
  role: row.role === "admin" ? "admin" : "member",
  dirName: row.dirName,
  status: (["invited", "active", "suspended"] as const).includes(row.status as UserStatus)
    ? (row.status as UserStatus)
    : "invited",
  gitName: row.gitName,
  gitEmail: row.gitEmail,
  createdBy: row.createdBy ?? null,
  createdAt: row.createdAt,
  lastActiveAt: row.lastActiveAt ?? null,
  ...(hasPendingInvite === undefined ? {} : { hasPendingInvite }),
});

export async function listUsers(): Promise<UserRow[]> {
  return db.select().from(users);
}

export async function getUser(userId: string): Promise<UserRow | null> {
  if (!userId) return null;
  return (await db.select().from(users).where(eq(users.id, userId))).at(0) ?? null;
}

export async function countUsers(): Promise<number> {
  return (await db.select().from(users)).length;
}

export async function createUser(input: {
  name: string;
  role: UserRole;
  dirName: string;
  gitName: string;
  gitEmail: string;
  createdBy: string | null;
}): Promise<UserRow> {
  const row: UserRow = {
    id: id(),
    name: input.name,
    role: input.role,
    dirName: input.dirName,
    status: "invited",
    keyHash: null,
    gitName: input.gitName,
    gitEmail: input.gitEmail,
    createdBy: input.createdBy,
    createdAt: now(),
    lastActiveAt: null,
  };
  await db.insert(users).values(row);
  return row;
}

export async function updateUser(userId: string, patch: Partial<UserRow>): Promise<void> {
  await db.update(users).set(patch).where(eq(users.id, userId));
}

/** 目录名是否已被占用(不区分大小写 —— 磁盘上多半也不区分)。 */
export async function dirNameTaken(dirName: string, exceptUserId?: string): Promise<boolean> {
  const lower = dirName.toLowerCase();
  return (await db.select().from(users)).some(
    (u) => u.dirName.toLowerCase() === lower && u.id !== exceptUserId,
  );
}

/** 姓名是否重名。不硬拦(重名是现实),但界面要提示。 */
export async function nameTaken(name: string, exceptUserId?: string): Promise<boolean> {
  const trimmed = name.trim();
  return (await db.select().from(users)).some((u) => u.name === trimmed && u.id !== exceptUserId);
}

/**
 * 拿明文 key 找人。**必须遍历**:每行的 scrypt 盐都不同,没法做等值查询。
 * 用户量是「小团队」量级(个位数到几十),一次登录多做几十次 scrypt 完全可接受;
 * 换成快哈希索引就把「库泄露 = 拿到所有 key」这条路又开回来了。
 */
export async function findUserByKey(plainKey: string): Promise<UserRow | null> {
  if (!plainKey.startsWith("ash_")) return null;
  for (const row of await db.select().from(users)) {
    if (verifyKey(plainKey, row.keyHash)) return row;
  }
  return null;
}

/** 生成新 key 并落哈希,返回明文(仅此一次)。同时把账号转 active。 */
export async function resetUserKey(userId: string): Promise<string> {
  const plain = mintKey();
  await db.update(users).set({ keyHash: hashKey(plain), status: "active" }).where(eq(users.id, userId));
  // 旧 key 即刻失效 = 连它换出来的 web 会话一起断,否则「重置」只是换了张门票、
  // 老的那张还在别人浏览器里活着(§三 key 轮换)。
  await deleteSessionsOf(userId);
  return plain;
}

export async function touchUser(userId: string): Promise<void> {
  await db.update(users).set({ lastActiveAt: now() }).where(eq(users.id, userId));
}

/**
 * 作废某人手上那把 key(管理员「重置 key」的第一步)。账号退回 invited,等他从新的
 * 专属邀请链接重领。**必须连会话一起断** —— 只清 keyHash 的话,他浏览器里那个
 * cookie 还能用 30 天,「重置」就只是个说法。
 */
export async function revokeUserKey(userId: string): Promise<void> {
  await db.update(users).set({ keyHash: null, status: "invited" }).where(eq(users.id, userId));
  await deleteSessionsOf(userId);
}

// ── web 会话 ────────────────────────────────────────────────────────────────

export async function createSession(userId: string, userAgent: string): Promise<string> {
  const token = mintToken();
  await db.insert(userSessions).values({
    id: id(),
    userId,
    tokenHash: tokenDigest(token),
    createdAt: now(),
    lastSeenAt: now(),
    expiresAt: daysFromNow(SESSION_DAYS),
    userAgent: userAgent.slice(0, 200),
  });
  return token;
}

/**
 * 会话 token → 用户。过期行**当场删掉**(顺手做 GC,不必另起一个定时器);
 * 命中就滑动续期。返回 null = 无效/过期/用户已停用。
 */
export async function resolveSession(token: string): Promise<UserRow | null> {
  if (!token) return null;
  const digest = tokenDigest(token);
  const row = (await db.select().from(userSessions).where(eq(userSessions.tokenHash, digest))).at(0);
  if (!row) return null;
  if (Date.parse(row.expiresAt) <= Date.now()) {
    await db.delete(userSessions).where(eq(userSessions.id, row.id));
    return null;
  }
  const user = await getUser(row.userId);
  if (!user || user.status === "suspended") return null;
  await db
    .update(userSessions)
    .set({ lastSeenAt: now(), expiresAt: daysFromNow(SESSION_DAYS) })
    .where(eq(userSessions.id, row.id));
  return user;
}

export async function deleteSession(token: string): Promise<void> {
  if (!token) return;
  await db.delete(userSessions).where(eq(userSessions.tokenHash, tokenDigest(token)));
}

/** 断掉某人的**所有**会话(停用 / 重置 key / 自助轮换都要这一下)。 */
export async function deleteSessionsOf(userId: string): Promise<void> {
  await db.delete(userSessions).where(eq(userSessions.userId, userId));
}

/** 启动时清一遍过期会话行。best-effort。 */
export async function sweepExpiredSessions(): Promise<void> {
  await db.delete(userSessions).where(sql`${userSessions.expiresAt} <= ${now()}`);
}

// ── 专属邀请链接 ────────────────────────────────────────────────────────────

export type InviteRow = typeof userInvites.$inferSelect;

/** 建一条新邀请,并作废该用户所有旧的未领取邀请(一人一链)。返回明文 token。 */
export async function issueInvite(userId: string, createdBy: string | null): Promise<string> {
  await db
    .update(userInvites)
    .set({ revokedAt: now() })
    .where(and(eq(userInvites.userId, userId), isNull(userInvites.consumedAt), isNull(userInvites.revokedAt)));
  const token = mintToken();
  await db.insert(userInvites).values({
    id: id(),
    userId,
    tokenHash: tokenDigest(token),
    createdBy,
    createdAt: now(),
    expiresAt: daysFromNow(INVITE_DAYS),
    consumedAt: null,
    revokedAt: null,
  });
  return token;
}

/** 邀请是否还能用。返回 null = token 不存在;返回 {invalid} = 存在但不可用。 */
export async function loadInvite(token: string): Promise<{ row: InviteRow; invalid: string | null } | null> {
  if (!token) return null;
  const row = (await db.select().from(userInvites).where(eq(userInvites.tokenHash, tokenDigest(token)))).at(0);
  if (!row) return null;
  if (row.revokedAt) return { row, invalid: "这条邀请链接已被管理员作废" };
  if (row.consumedAt) return { row, invalid: "这条邀请链接已经被领取过了" };
  if (Date.parse(row.expiresAt) <= Date.now()) return { row, invalid: "这条邀请链接已过期(7 天)，找管理员重发" };
  return { row, invalid: null };
}

/** 点了「我已保存」:作废链接。**领取时不作废** —— 见 §五「避免手滑点开就锁死」。 */
export async function consumeInvite(inviteId: string): Promise<void> {
  await db.update(userInvites).set({ consumedAt: now() }).where(eq(userInvites.id, inviteId));
}

export async function revokeInvitesOf(userId: string): Promise<void> {
  await db
    .update(userInvites)
    .set({ revokedAt: now() })
    .where(and(eq(userInvites.userId, userId), isNull(userInvites.consumedAt), isNull(userInvites.revokedAt)));
}

/** 有没有还能用的邀请(用户列表里的「待领取」角标)。 */
export async function pendingInviteUserIds(): Promise<Set<string>> {
  const rows = await db
    .select()
    .from(userInvites)
    .where(and(isNull(userInvites.consumedAt), isNull(userInvites.revokedAt)));
  const live = new Set<string>();
  for (const row of rows) {
    if (Date.parse(row.expiresAt) > Date.now()) live.add(row.userId);
  }
  return live;
}

/** 删用户不做(§五 只停用),但删邀请/会话在停用时要做。 */
export async function suspendUser(userId: string): Promise<void> {
  await updateUser(userId, { status: "suspended" });
  await deleteSessionsOf(userId);
}

export async function resumeUser(userId: string): Promise<void> {
  const user = await getUser(userId);
  if (!user) return;
  // 还没领过 key 的人恢复后仍是 invited —— 别把「停用一个从没登录过的账号」
  // 恢复成 active,那会让他永远没有可用凭证却显示正常。
  await updateUser(userId, { status: user.keyHash ? "active" : "invited" });
}

/** 实例里还剩几个可用的管理员(降级/停用最后一个管理员要拦)。 */
export async function activeAdminCount(exceptUserId?: string): Promise<number> {
  return (await db.select().from(users)).filter(
    (u) => u.role === "admin" && u.status !== "suspended" && u.id !== exceptUserId,
  ).length;
}

/** 首个管理员(逃生门与存量归属都要认它)。按创建时间取最早的那个。 */
export async function firstAdmin(): Promise<UserRow | null> {
  const admins = (await db.select().from(users)).filter((u) => u.role === "admin");
  admins.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return admins[0] ?? null;
}

/** 给「选人直加」用的名单:全员可见(§四),但停用的排在后面并标出来。 */
export async function listActiveUsers(): Promise<UserRow[]> {
  return (await db.select().from(users)).filter((u) => u.status !== "suspended");
}

export async function usersByIds(ids: string[]): Promise<Map<string, UserRow>> {
  if (!ids.length) return new Map();
  const rows = await db.select().from(users);
  const wanted = new Set(ids);
  return new Map(rows.filter((r) => wanted.has(r.id)).map((r) => [r.id, r]));
}

/** 转多人时把存量归属实名化用的条件片段(owner 为空的行)。 */
export const ownerIsNull = (column: Parameters<typeof isNull>[0]) => or(isNull(column), eq(column as never, "" as never));
