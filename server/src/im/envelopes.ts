// 按钮信封：卡片上的按钮只带一个随机 id，这一下点击有没有效全在库里判。
//
// 依次四关，任一不过就拒（拒绝时卡片保持原样或改成「已过时」，不执行任何动作）：
//   ① 有这个信封、没过期（14 天：飞书只允许改 14 天内的消息，再旧的卡也没法回写结果）；
//   ② 点的人对：单聊卡只认收件人本人；群卡片（收件人为空）认任何**绑定过**的人，执行时用
//      他自己的身份，权限照他本人的算；
//   ③ 没被用过（并发两下只有一下抢得到，CAS 在 claim 里）；
//   ④ 事情还是那件事：发卡时记下的代次与此刻现算的一致（attention.ts），否则是旧卡。
//
// 占用记下是哪个进程占的（claimed_by）：点下去之后、办完之前进程没了，信封就停在「已占用、没结果」，
// 永远显示「已经处理过了」。重启后 unfinishedEnvelopes 把这些找出来，由 actions.ts 判断那一下到底
// 办成了没有 —— 不能一股脑放回去，办成了的再执行一遍就是重复副作用。
import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../db/index.js";
import { imActions } from "../db/schema-im.js";
import { now } from "../util.js";

export const ENVELOPE_TTL_MS = 14 * 24 * 3600_000;

/** 本进程的占用标识：重启后换一个，旧进程占着没办完的就认得出来。 */
const CLAIMER = `${process.pid}:${nanoid(8)}`;

export type EnvelopeRow = typeof imActions.$inferSelect;

export async function createEnvelope(input: {
  outboxId: string;
  taskId: string | null;
  action: string;
  payload?: Record<string, unknown>;
  recipientOpenId: string | null;
  generation: string;
  ttlMs?: number;
}): Promise<string> {
  const envelopeId = nanoid(22);
  await db.insert(imActions).values({
    id: envelopeId,
    outboxId: input.outboxId,
    taskId: input.taskId,
    action: input.action,
    payload: JSON.stringify(input.payload ?? {}),
    recipientOpenId: input.recipientOpenId ?? "",
    generation: input.generation,
    expiresAt: new Date(Date.now() + (input.ttlMs ?? ENVELOPE_TTL_MS)).toISOString(),
    createdAt: now(),
  });
  return envelopeId;
}

export async function loadEnvelope(envelopeId: string): Promise<EnvelopeRow | null> {
  if (typeof envelopeId !== "string" || !/^[\w-]{10,40}$/.test(envelopeId)) return null;
  return (await db.select().from(imActions).where(eq(imActions.id, envelopeId))).at(0) ?? null;
}

export type EnvelopeCheck =
  | { ok: true; envelope: EnvelopeRow; payload: Record<string, unknown> }
  | { ok: false; reason: "missing" | "expired" | "not_yours" | "used"; envelope?: EnvelopeRow };

/** ①②③ 三关（④ 要读任务现状，由调用方做）。 */
export async function checkEnvelope(envelopeId: string, operatorOpenId: string, at = Date.now()): Promise<EnvelopeCheck> {
  const envelope = await loadEnvelope(envelopeId);
  if (!envelope) return { ok: false, reason: "missing" };
  if (Date.parse(envelope.expiresAt) <= at) return { ok: false, reason: "expired", envelope };
  if (envelope.recipientOpenId && envelope.recipientOpenId !== operatorOpenId) return { ok: false, reason: "not_yours", envelope };
  if (envelope.usedAt) return { ok: false, reason: "used", envelope };
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(envelope.payload); } catch { /* 坏了按空的 */ }
  return { ok: true, envelope, payload };
}

/** 占用信封。返回 false = 刚被另一下点击抢先了。result 清空：上一次没做成留下的原因不算「办完了」。 */
export async function claimEnvelope(envelopeId: string): Promise<boolean> {
  const rows = await db.update(imActions).set({ usedAt: now(), claimedBy: CLAIMER, result: null })
    .where(and(eq(imActions.id, envelopeId), isNull(imActions.usedAt))).returning({ id: imActions.id });
  return rows.length > 0;
}

/** 动作没做成（接口拒了）：放回去，用户改改还能再点。 */
export async function releaseEnvelope(envelopeId: string, result: string): Promise<void> {
  await db.update(imActions).set({ usedAt: null, claimedBy: null, result }).where(eq(imActions.id, envelopeId));
}

export async function finishEnvelope(envelopeId: string, result: string): Promise<void> {
  await db.update(imActions).set({ result }).where(eq(imActions.id, envelopeId));
}

/** 别的进程（上一次运行）占着、没办完的信封。 */
export async function unfinishedEnvelopes(): Promise<EnvelopeRow[]> {
  return db.select().from(imActions).where(and(
    isNotNull(imActions.usedAt), isNull(imActions.result),
    or(isNull(imActions.claimedBy), ne(imActions.claimedBy, CLAIMER)),
  ));
}
