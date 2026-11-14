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
// （result = 回写用户刚点的那一下，额度见底也照发）；acking = 结果卡已随卡片回调回执带回去、还没确认
// 送到，next_at 到期还没确认就当 result 改一次（至少交付一次，同样的内容改两次没有副作用）；
// done / skipped / failed 是结果。改卡失败按 next_at 退避，不在同一圈里连撞。
// recall = 不改了、整条撤回（卡上那件事没了、任务只是又跑起来了：留一张「又开始跑了」的灰卡没人要看，reconcile.ts
// resolve）；撤回不了（发出超过一天、类型不支持）就退回成改卡，改成库里那份收好的样子。recalled = 已撤回。
//
// 发出和改卡都要先过出口核对（OutboxGuard，构造时必须给，由对账器实现）：入队时的授权与隐私设置
// 不是发出那一刻的 —— 排着队的时候收件人可能解了绑、被移出了项目，项目可能改成了只推标题（scope.ts）。
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { imOutbox } from "../db/schema-im.js";
import { now } from "../util.js";
import { isAnchorGone, isMessageGone, isQuotaBlocked, isTokenFailure, type FeishuApi } from "./feishu/api.js";
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
// 取 token 失败（凭证被轮换、应用停用）：不算这一条的尝试次数，隔一阵再试；凭证修好后积压的自然发出去、改过来。
const TOKEN_RETRY_MS = 5 * 60_000;

/** 决策卡（带按钮、要人拍板）的 kind。 */
export const DECISION_OUTBOX_KINDS = ["question", "failed", "dispute", "duet_gate", "accept", "confirm", "summary", "pair"] as const;

export function purposeOfKind(kind: string): ImPurpose {
  if ((DECISION_OUTBOX_KINDS as readonly string[]).includes(kind)) return "decision";
  // fail = 点下去没办成的原因：和回写结果同一个用途，额度见底也要让他知道那一下没生效。
  if (kind === "fail") return "result";
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

/**
 * 出口核对。返回此刻该发 / 该改成的那一行（内容可能刚重渲染过、换成了只推标题版、或者收件人已无权查看
 * 而换成了中性的收起卡），null = 不发了 / 不用改了。
 */
export interface OutboxGuard {
  send(row: OutboxRow): Promise<OutboxRow | null>;
  patch(row: OutboxRow): Promise<OutboxRow | null>;
}

const GUARD_RETRY_MS = 30_000;
/** 还要改到飞书上的（acking 另按期限算）。 */
const PATCHING = ["pending", "result", "recall"];
export const RECALL = "recall";
export const RECALLED = "recalled";

export class OutboxSender {
  private running = false;
  private again = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly api: FeishuApi,
    private readonly appId: string,
    private readonly guard: OutboxGuard,
    private readonly clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); }),
    },
    /** 撤回出去的那条消息，库里那一行却刚被救回成能点的卡：行已作废，叫对账按现状重推（recallOne）。 */
    private readonly onLost: (taskId: string) => void = () => {},
  ) {}

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
    const at = new Date(this.clock.now()).toISOString();
    return (await db.select().from(imOutbox).where(and(
      eq(imOutbox.appId, this.appId), isNotNull(imOutbox.messageId),
      or(
        and(inArray(imOutbox.patchState, PATCHING), or(isNull(imOutbox.nextAt), lte(imOutbox.nextAt, at))),
        and(eq(imOutbox.patchState, "acking"), lte(imOutbox.nextAt, at)),
      ),
    )).orderBy(asc(imOutbox.updatedAt)).limit(1)).at(0) ?? null;
  }

  /** 核对本身出错（读库失败等）：宁可晚发，不在没核过的情况下发 / 改。 */
  private async guarded(row: OutboxRow, mode: keyof OutboxGuard): Promise<OutboxRow | null | "error"> {
    try {
      return await this.guard[mode](row);
    } catch (error) {
      console.error(`[ash] 飞书${mode === "send" ? "发件" : "改卡"}前核对出错:`, error);
      await db.update(imOutbox).set({ nextAt: new Date(this.clock.now() + GUARD_RETRY_MS).toISOString(), updatedAt: now() })
        .where(eq(imOutbox.id, row.id));
      return "error";
    }
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      // 改卡排在发新卡前面：回写结果是用户正盯着看的。
      const patch = await this.nextPatch();
      if (patch?.patchState === RECALL) {
        // 撤回只会收回内容，不用先过出口核对。
        await this.recallOne(patch);
        await this.clock.sleep(SPACING_MS);
        continue;
      }
      if (patch) {
        const vetted = await this.guarded(patch, "patch");
        if (vetted === "error") continue;
        if (!vetted) {
          // 不用改了（行没了、没有可改的消息）：标掉，免得下一圈又捡到它。
          await db.update(imOutbox).set({ patchState: "skipped", updatedAt: now() })
            .where(and(eq(imOutbox.id, patch.id), eq(imOutbox.content, patch.content), eq(imOutbox.patchState, patch.patchState!)));
          continue;
        }
        await this.patchOne(vetted);
        await this.clock.sleep(SPACING_MS);
        continue;
      }
      const next = await this.nextSend();
      if (!next) return;
      const send = await this.guarded(next, "send");
      if (!send || send === "error") continue;
      await this.sendOne(send);
      await this.clock.sleep(SPACING_MS);
    }
  }

  /** 这一行要发 / 要改成的内容。解析不了就标成放弃、记下原因（返回 undefined）：一行坏的每圈都抛错，会把后面整条队列卡住。 */
  private async contentOf(row: OutboxRow, mode: "send" | "patch"): Promise<unknown> {
    try {
      return JSON.parse(row.content) as unknown;
    } catch (error) {
      const lastError = `内容解析不了：${(error as Error).message}`.slice(0, 500);
      console.warn(`[ash] 飞书${mode === "send" ? "消息放弃发送" : "卡片放弃改写"}（${row.kind} ${row.taskId ?? ""}）：${lastError}`);
      await db.update(imOutbox).set(mode === "send" ? { state: "dead", nextAt: null, lastError, updatedAt: now() } : { patchState: "skipped", lastError, updatedAt: now() })
        .where(and(eq(imOutbox.id, row.id), eq(imOutbox.content, row.content)));
      return undefined;
    }
  }

  private async sendOne(row: OutboxRow): Promise<void> {
    const content = await this.contentOf(row, "send");
    if (content === undefined) return;
    const msg = { msgType: row.msgType as "interactive" | "text", content };
    const purpose = purposeOfKind(row.kind);
    const to = { type: row.receiveType as "open_id" | "chat_id", id: row.receiveId };
    let res = row.replyTo ? await this.api.reply(row.replyTo, msg, row.id, purpose, row.replyInThread === 1) : await this.api.send(to, msg, row.id, purpose);
    // 被回复的那条撤回了、看不到了：不带锚点直接发进同一个会话（另一个 uuid：飞书按 uuid 判重，别跟那次失败的回复撞上）。
    if (row.replyTo && isAnchorGone(res)) res = await this.api.send(to, msg, `a${row.id}`, purpose);
    const at = now();
    if (res.ok) {
      // 发出去的这段时间里它可能已经被收掉（resolved）、或者重渲染过：库里那份才是该有的样子，
      // 与刚发出去的不一样就排一次改卡（SET 里的列都按更新前的值算）。
      // 已经排着结果回写的（result / acking）不降级成 pending：那是额度见底也要发的用途。
      await db.update(imOutbox).set({
        messageId: res.data.messageId,
        sentAt: at,
        updatedAt: at,
        state: sql`CASE WHEN ${imOutbox.state} = 'pending' THEN 'sent' ELSE ${imOutbox.state} END`,
        // 文字消息改不了，不排改卡。
        ...(row.msgType !== "interactive" ? {} : {
          // 发的途中就收起来、要撤回的（reconcile.ts resolve）：刚发出去就撤，不改成一张灰卡。
          patchState: sql`CASE WHEN ${imOutbox.patchState} IN ('result', 'acking') THEN 'result'
            WHEN ${imOutbox.patchState} = 'recall' AND ${imOutbox.state} = 'resolved' THEN 'recall'
            WHEN ${imOutbox.state} = 'resolved' OR ${imOutbox.content} <> ${row.content} THEN 'pending' ELSE ${imOutbox.patchState} END`,
        }),
        attempts: 0,
        nextAt: null,
        lastError: null,
      }).where(eq(imOutbox.id, row.id));
      return;
    }
    if (isQuotaBlocked(res) || isTokenFailure(res)) {
      const wait = isTokenFailure(res) ? TOKEN_RETRY_MS : QUOTA_RETRY_MS;
      await db.update(imOutbox).set({ nextAt: new Date(this.clock.now() + wait).toISOString(), lastError: res.msg, updatedAt: at })
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

  private async recallOne(row: OutboxRow): Promise<void> {
    const res = await this.api.recall(row.messageId!, "resolved");
    const at = now();
    // 230011 = 已经撤回了：上一次撤回其实成了、只是回执没收到（超时、断网），这一次照样算撤回成了。
    if (res.ok || isMessageGone(res)) {
      await this.gone(row, null);
      return;
    }
    const lastError = `${res.code} ${res.msg}`.slice(0, 500);
    if (isQuotaBlocked(res)) {
      await db.update(imOutbox).set({ patchState: "skipped", lastError, updatedAt: at }).where(and(eq(imOutbox.id, row.id), eq(imOutbox.patchState, RECALL)));
      return;
    }
    const attempts = row.attempts + 1;
    if (isTokenFailure(res) || (res.retryable && attempts <= BACKOFF_MS.length)) {
      const wait = isTokenFailure(res) ? TOKEN_RETRY_MS : BACKOFF_MS[attempts - 1]!;
      await db.update(imOutbox).set({ attempts: isTokenFailure(res) ? row.attempts : attempts, lastError, updatedAt: at, nextAt: new Date(this.clock.now() + wait).toISOString() })
        .where(and(eq(imOutbox.id, row.id), eq(imOutbox.patchState, RECALL)));
      return;
    }
    // 撤回不了（超过一天、这类消息不支持）：退回成改卡，卡上换成库里那份收好的样子。
    await db.update(imOutbox).set({ patchState: "pending", attempts: 0, lastError, nextAt: null, updatedAt: at })
      .where(and(eq(imOutbox.id, row.id), eq(imOutbox.patchState, RECALL)));
  }

  /**
   * 这一行的那条消息在飞书上已经没了（撤回成了，或者撤回 / 改卡回「消息已撤回」）。这一行还收着（resolved）：记成撤回了，
   * 不再去改它；同一件事回来时对账看到 recalled 会另推一条（reconcile.ts settleTask）。这一行已经被对账救了回来（revive
   * 换成了能点的卡、排着改卡）：改不回来，照原 uuid 重发也只会拿回那条撤回的（飞书一小时内按 uuid 判重）—— 作废这一行，
   * 交给对账另起一行重推。
   */
  private async gone(row: OutboxRow, lastError: string | null): Promise<void> {
    const that = and(eq(imOutbox.id, row.id), eq(imOutbox.messageId, row.messageId!));
    const settled = await db.update(imOutbox).set({ patchState: RECALLED, attempts: 0, nextAt: null, lastError, updatedAt: now() })
      .where(and(that, eq(imOutbox.state, "resolved"))).returning({ id: imOutbox.id });
    if (settled.length) return;
    await db.delete(imOutbox).where(that);
    if (row.taskId) this.onLost(row.taskId);
  }

  private async patchOne(row: OutboxRow): Promise<void> {
    const purpose: ImPurpose = row.patchState === "result" || row.patchState === "acking" ? "result" : row.state === "resolved" ? "resolved" : "decision";
    const snapshot = row.content;
    const card = await this.contentOf(row, "patch");
    if (card === undefined) return;
    const res = await this.api.patchCard(row.messageId!, card, purpose);
    const at = now();
    if (res.ok) {
      // 改卡期间 content 又变了（又一次对账、按钮落了结局）：CAS 落空，保持待改，下一圈再改一次。
      const done = await db.update(imOutbox).set({ patchState: "done", attempts: 0, nextAt: null, lastError: null, updatedAt: at })
        .where(and(eq(imOutbox.id, row.id), eq(imOutbox.content, snapshot))).returning({ id: imOutbox.id });
      // 新的那份若是随回执带回去的（acking），或已经按回执送到记成了 done，它可能先于刚改出去的这份旧的落到卡上：
      // 不改就停在旧的。照样排一次结果回写，让库里那份最后落下（actions.ts 文件头的约定）。
      if (!done.length) {
        await db.update(imOutbox).set({ patchState: "result", nextAt: null, updatedAt: at })
          .where(and(eq(imOutbox.id, row.id), inArray(imOutbox.patchState, ["acking", "done"])));
      }
      return;
    }
    const lastError = `${res.code} ${res.msg}`.slice(0, 500);
    // 改的那条在飞书上已经没了（撤回成了却没收到回执、之后又被救回成能点的卡）：改多少次都是这个错。
    if (isMessageGone(res)) {
      await this.gone(row, lastError);
      return;
    }
    if (isQuotaBlocked(res)) {
      await db.update(imOutbox).set({ patchState: "skipped", lastError, updatedAt: at }).where(and(eq(imOutbox.id, row.id), eq(imOutbox.content, snapshot)));
      return;
    }
    if (isTokenFailure(res)) {
      await db.update(imOutbox).set({
        lastError, updatedAt: at, nextAt: new Date(this.clock.now() + TOKEN_RETRY_MS).toISOString(),
        ...(row.patchState === "acking" ? { patchState: "result" } : {}),
      }).where(eq(imOutbox.id, row.id));
      return;
    }
    const attempts = row.attempts + 1;
    if (!res.retryable || attempts > BACKOFF_MS.length) {
      await db.update(imOutbox).set({ patchState: "failed", attempts, lastError, updatedAt: at }).where(and(eq(imOutbox.id, row.id), eq(imOutbox.content, snapshot)));
      console.warn(`[ash] 飞书改卡放弃（${row.kind} ${row.taskId ?? ""}）：${lastError}`);
      return;
    }
    // 退避重试。acking 到这里已经过期没确认，改成 result 继续按退避改。
    await db.update(imOutbox).set({
      attempts, lastError, updatedAt: at, nextAt: new Date(this.clock.now() + BACKOFF_MS[attempts - 1]!).toISOString(),
      ...(row.patchState === "acking" ? { patchState: "result" } : {}),
    }).where(eq(imOutbox.id, row.id));
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
