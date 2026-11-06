// 发件队列：im_outbox 里的每一行都是一条「要发 / 要改」的飞书消息。
//
// 为什么不直接调发送接口：
//   · 崩溃安全 —— 先落库再发，行 id 就是飞书的 uuid（1 小时内同一 uuid 只成功一次），重启后
//     重发不会推两条；
//   · 限速 —— 单个用户 5 QPS，这里串行、每两次之间隔 220ms；
//   · 额度 —— 每次调用前过 QuotaMeter（../quota.ts），按用途降级；被拦下的不算失败，过一会儿再看。
//
// 一行的生命：pending →（发出）sent →（别处处理掉 / 换了下一步）resolved；held = 已登记、
// 先不推（一口气积压太多时只发一张汇总，逐张的等用户要）；重试耗尽 → dead。
// 改卡单独记在 patch_state：pending / result = 库里的 content 比飞书上那张新，要 PATCH 过去
// （result = 回写用户刚点的那一下，额度见底也照发）；done / skipped / failed 是结果。
//
// 发件边界还要再核一次（guard，由对账器挂上）：入队时的授权与隐私设置不是发出那一刻的 ——
// 排着队的时候项目可能改成了只推标题、收件人可能被移出了项目、进程可能刚重启还没对过账。
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { imOutbox } from "../db/schema-im.js";
import { now } from "../util.js";
import { isQuotaBlocked, type FeishuApi } from "./feishu/api.js";
import type { ImPurpose } from "./quota.js";

export type OutboxRow = typeof imOutbox.$inferSelect;

export interface Destination {
  receiveType: "open_id" | "chat_id";
  receiveId: string;
  /** 单聊收件人；群为 null。 */
  recipientOpenId: string | null;
}

const SPACING_MS = 220;
const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000];
const QUOTA_RETRY_MS = 30 * 60_000;

/** 决策卡（带按钮、要人拍板）的 kind。 */
export const DECISION_OUTBOX_KINDS = ["question", "failed", "dispute", "duet_gate", "accept", "confirm", "summary"] as const;

export function purposeOfKind(kind: string): ImPurpose {
  if ((DECISION_OUTBOX_KINDS as readonly string[]).includes(kind)) return "decision";
  if (kind === "reply" || kind === "bind") return "reply";
  return "notice";
}

/** 卡片 content 里的标题与副标题（改成「已处理」时沿用）。 */
export function cardHeaderOf(content: string): { title: string; subtitle?: string } {
  try {
    const card = JSON.parse(content) as { header?: { title?: { content?: string }; subtitle?: { content?: string } } };
    return { title: card.header?.title?.content ?? "ash", subtitle: card.header?.subtitle?.content };
  } catch {
    return { title: "ash" };
  }
}

/** 发之前的最后一道核对：返回此刻该发的那一行（内容可能刚重渲染过），null = 不发了。 */
export type SendGuard = (row: OutboxRow) => Promise<OutboxRow | null>;

const GUARD_RETRY_MS = 30_000;

export class OutboxSender {
  private guard: SendGuard | null = null;
  private running = false;
  private again = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly api: FeishuApi,
    private readonly appId: string,
    private readonly clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); }),
    },
  ) {}

  setGuard(guard: SendGuard): void {
    this.guard = guard;
  }

  start(): void {
    this.stopped = false;
    // 重试的到期时间写在 next_at 上，这一下轮询负责把它们捡起来。
    this.timer = setInterval(() => this.kick(), 30_000);
    this.timer.unref?.();
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 有新东西要发 / 要改了。并发调用合并成一次排空。 */
  kick(): void {
    if (this.stopped) return;
    if (this.running) { this.again = true; return; }
    this.running = true;
    void this.drain().catch((error) => console.error("[ash] 飞书发件队列出错:", error))
      .finally(() => {
        this.running = false;
        if (this.again && !this.stopped) { this.again = false; this.kick(); }
      });
  }

  /** 测试用：排空到没有到期的活为止。 */
  async drainNow(): Promise<void> {
    while (this.running) await this.clock.sleep(5);
    this.running = true;
    try { await this.drain(); } finally { this.running = false; }
  }

  private async nextSend(): Promise<OutboxRow | null> {
    const at = new Date(this.clock.now()).toISOString();
    return (await db.select().from(imOutbox).where(and(
      eq(imOutbox.appId, this.appId), eq(imOutbox.state, "pending"),
      or(isNull(imOutbox.nextAt), lte(imOutbox.nextAt, at)),
    )).orderBy(asc(imOutbox.createdAt)).limit(1)).at(0) ?? null;
  }

  private async nextPatch(): Promise<OutboxRow | null> {
    return (await db.select().from(imOutbox).where(and(
      eq(imOutbox.appId, this.appId), isNotNull(imOutbox.messageId), inArray(imOutbox.patchState, ["pending", "result"]),
    )).orderBy(asc(imOutbox.updatedAt)).limit(1)).at(0) ?? null;
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      // 改卡排在发新卡前面：回写结果是用户正盯着看的。
      const patch = await this.nextPatch();
      if (patch) { await this.patchOne(patch); await this.clock.sleep(SPACING_MS); continue; }
      const next = await this.nextSend();
      if (!next) return;
      let send: OutboxRow | null = next;
      if (this.guard) {
        try {
          send = await this.guard(next);
        } catch (error) {
          // 核对本身出错（读库失败等）：宁可晚发，不在没核过的情况下发。
          console.error("[ash] 飞书发件前核对出错:", error);
          await db.update(imOutbox).set({ nextAt: new Date(this.clock.now() + GUARD_RETRY_MS).toISOString(), updatedAt: now() })
            .where(eq(imOutbox.id, next.id));
          continue;
        }
      }
      if (!send) continue;
      await this.sendOne(send);
      await this.clock.sleep(SPACING_MS);
    }
  }

  private async sendOne(row: OutboxRow): Promise<void> {
    const msg = { msgType: row.msgType as "interactive" | "text", content: JSON.parse(row.content) as unknown };
    const purpose = purposeOfKind(row.kind);
    const res = row.replyTo
      ? await this.api.reply(row.replyTo, msg, row.id, purpose, row.replyInThread === 1)
      : await this.api.send({ type: row.receiveType as "open_id" | "chat_id", id: row.receiveId }, msg, row.id, purpose);
    const at = now();
    if (res.ok) {
      // 发出去的这段时间里它可能已经被收掉（resolved）、或者重渲染过：库里那份才是该有的样子，
      // 与刚发出去的不一样就排一次改卡（SET 里的列都按更新前的值算）。
      await db.update(imOutbox).set({
        messageId: res.data.messageId,
        sentAt: at,
        updatedAt: at,
        state: sql`CASE WHEN ${imOutbox.state} = 'pending' THEN 'sent' ELSE ${imOutbox.state} END`,
        patchState: sql`CASE WHEN ${imOutbox.state} = 'resolved' OR ${imOutbox.content} <> ${row.content} THEN 'pending' ELSE ${imOutbox.patchState} END`,
        lastError: null,
      }).where(eq(imOutbox.id, row.id));
      return;
    }
    if (isQuotaBlocked(res)) {
      await db.update(imOutbox).set({ nextAt: new Date(this.clock.now() + QUOTA_RETRY_MS).toISOString(), lastError: res.msg, updatedAt: at })
        .where(eq(imOutbox.id, row.id));
      return;
    }
    const attempts = row.attempts + 1;
    const dead = !res.retryable || attempts > BACKOFF_MS.length;
    await db.update(imOutbox).set({
      attempts,
      lastError: `${res.code} ${res.msg}`.slice(0, 500),
      state: dead ? "dead" : "pending",
      nextAt: dead ? null : new Date(this.clock.now() + BACKOFF_MS[attempts - 1]!).toISOString(),
      updatedAt: at,
    }).where(and(eq(imOutbox.id, row.id), eq(imOutbox.state, "pending")));
    if (dead) console.warn(`[ash] 飞书消息放弃发送（${row.kind} ${row.taskId ?? ""}）：${res.code} ${res.msg}`);
  }

  private async patchOne(row: OutboxRow): Promise<void> {
    const purpose: ImPurpose = row.patchState === "result" ? "result" : row.state === "resolved" ? "resolved" : "decision";
    const snapshot = row.content;
    const res = await this.api.patchCard(row.messageId!, JSON.parse(snapshot), purpose);
    const at = now();
    // 改卡期间 content 又变了（又一次对账）：保持 pending，下一圈再改一次。
    const settled = res.ok ? "done" : isQuotaBlocked(res) ? "skipped" : res.retryable && row.attempts < 3 ? null : "failed";
    if (settled === null) {
      await db.update(imOutbox).set({ attempts: row.attempts + 1, lastError: `${res.ok ? "" : `${res.code} ${res.msg}`}`.slice(0, 500), updatedAt: at })
        .where(eq(imOutbox.id, row.id));
      return;
    }
    await db.update(imOutbox).set({
      patchState: settled,
      updatedAt: at,
      ...(res.ok ? {} : { lastError: `${res.code} ${res.msg}`.slice(0, 500) }),
    }).where(and(eq(imOutbox.id, row.id), eq(imOutbox.content, snapshot)));
  }
}

/** 网页上「发件积压」那一格。 */
export async function outboxCounts(appId: string): Promise<{ pending: number; dead: number }> {
  const rows = await db.select({ state: imOutbox.state, n: sql<number>`count(*)`.mapWith(Number) })
    .from(imOutbox).where(and(eq(imOutbox.appId, appId), inArray(imOutbox.state, ["pending", "dead"])))
    .groupBy(imOutbox.state);
  return {
    pending: rows.find((row) => row.state === "pending")?.n ?? 0,
    dead: rows.find((row) => row.state === "dead")?.n ?? 0,
  };
}
