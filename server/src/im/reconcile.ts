// 推送靠**对账**驱动，不靠「某个事件发生时发一条」。
//
// 每当任务有动静（bus 上的 task.* / duet.gate），把它记成脏；稍后统一算一遍「这个任务此刻
// 要人做哪件事」（attention.ts），和发件表里已经推过的卡比：
//   · 卡还对得上（同一件事、同一代、同一个收件人）→ 不动；
//   · 对不上 → 那张卡收成「已处理 / 已过时」的样子（改卡，不弹提醒）；
//   · 该有而没有 → 新卡入队。
// 为什么不按事件发：事件会丢（重启、订阅晚了）、会乱序、会重复，删任务干脆没有事件；对账
// 只看现状，漏几个事件也只是晚一点对上，不会推错。启动时全量对一次，补上停机期间的变化。
//
// 一口气要新推的卡太多（刚绑定时有一堆历史待验收、重启后积压）→ 这些卡登记成 held、只发
// 一张汇总，用户点「逐张推给我」或发 /todo 再推。
import { isAcceptedStage } from "@ash/shared";
import { and, desc, eq, gt, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../db/index.js";
import { acceptGateRuns } from "../db/schema-accept-gate.js";
import { imOutbox } from "../db/schema-im.js";
import { tasks } from "../db/schema.js";
import { openDisputeTargets } from "../free-review-dispute.js";
import { now } from "../util.js";
import { DECISION_KINDS, viewsOf, withTeamLeads, type TaskView, type Turn } from "./attention.js";
import { KIND_LABEL, settledCard, summaryCard, taskLink, turnCard } from "./cards.js";
import { createEnvelope } from "./envelopes.js";
import { extrasFor } from "./extras.js";
import { renderCard } from "./feishu/cards.js";
import { readOptions } from "./meta.js";
import { cardHeaderOf, type Destination, type OutboxRow, type OutboxSender } from "./outbox.js";
import { destinationsFor } from "./recipients.js";

export const FLOOD_LIMIT = 5;
const TURN_KINDS = ["question", "failed", "dispute", "duet_gate", "verify_failed", "accept"] as const;
const OPEN_STATES = ["pending", "sent", "held"];
/** 卡片被点过、结果已回写（不许被对账「复活」成原样）。 */
export const ACTED = "acted";
const BATCH = 40;

interface Creation {
  view: TaskView & { turn: Turn };
  dest: Destination;
}

export class Reconciler {
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly appId: string, private readonly sender: OutboxSender) {}

  /** 发件表的所有改动都排进这一条链：对账和按钮回调不会交错改同一行。 */
  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job, job);
    this.chain = next.catch(() => {});
    return next;
  }

  /** bus 订阅里调：只记下 id，什么都不读（订阅回调里抛错会打断发布方）。 */
  mark(taskId: string): void {
    if (this.stopped || !taskId) return;
    this.dirty.add(taskId);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const ids = [...this.dirty];
      this.dirty.clear();
      void this.run(() => this.reconcile(ids)).catch((error) => console.error("[ash] 飞书对账出错:", error));
    }, 300);
    this.timer.unref?.();
  }

  /** 只入了队、不涉及任务的消息（命令回执、助手回复）：叫醒发件队列。 */
  kick(): void {
    this.sender.kick();
  }

  /**
   * 不发总线事件的改动（归档 / 取回、删任务、删项目）：防抖后整盘对一次。
   * 团队归档连执行者一起走、删项目连任务一起删，单 mark 一个 id 收不全。
   */
  sweepSoon(): void {
    if (this.stopped || this.sweepTimer) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      void this.full().catch((error) => console.error("[ash] 飞书对账出错:", error));
    }, 300);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.timer = null;
    this.sweepTimer = null;
  }

  /** 启动时、绑定刚生效时：把所有可能要人管的任务都对一遍。 */
  async full(): Promise<void> {
    const candidates = await db.select({ id: tasks.id }).from(tasks).where(and(
      eq(tasks.archived, false),
      or(
        isNotNull(tasks.question),
        inArray(tasks.status, ["failed", "done", "awaiting_review", "idle", "paused"]),
        eq(tasks.stage, "verify_failed"),
      ),
      or(sql`${tasks.stage} IS NULL`, sql`${tasks.stage} NOT IN ('accepted', 'merged')`),
    ));
    const open = await db.selectDistinct({ id: imOutbox.taskId }).from(imOutbox)
      .where(and(eq(imOutbox.appId, this.appId), inArray(imOutbox.state, OPEN_STATES), isNotNull(imOutbox.taskId)));
    const disputes = (await openDisputeTargets()).map((target) => target.taskId);
    const ids = [...new Set([...candidates.map((row) => row.id), ...open.map((row) => row.id!), ...disputes])];
    await this.run(() => this.reconcile(ids));
  }

  async reconcile(taskIds: string[]): Promise<void> {
    const ids = await withTeamLeads(taskIds);
    const options = await readOptions();
    const creations: Creation[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const views = await viewsOf(ids.slice(i, i + BATCH));
      for (const [taskId, view] of views) creations.push(...await this.settleTask(taskId, view, options.publicBaseUrl, options.notifyCompleted));
    }
    await this.create(creations, options.publicBaseUrl, options.titleOnlyProjectIds);
    this.sender.kick();
  }

  /** 对一个任务：收掉对不上的卡，返回该新推的。 */
  private async settleTask(taskId: string, view: TaskView | null, base: string | null, notifyCompleted: boolean): Promise<Creation[]> {
    const turn = view?.turn ?? null;
    const dests = view && turn ? await destinationsFor(this.appId, view) : [];
    const rows = await db.select().from(imOutbox).where(and(
      eq(imOutbox.appId, this.appId), eq(imOutbox.taskId, taskId), inArray(imOutbox.kind, [...TURN_KINDS]),
    ));
    for (const row of rows) {
      if (!OPEN_STATES.includes(row.state)) continue;
      const keep = !!turn && row.kind === turn.kind && row.subject === turn.generation && dests.some((d) => d.receiveId === row.receiveId);
      if (keep) continue;
      const text = await resolutionText(row, view);
      await this.resolve(row, text, view ? taskLink(base, view) : null);
      if (notifyCompleted && row.kind === "accept" && row.messageId && view && isAcceptedStage(view.task.stage)) {
        await this.notice(row, `已验收合并：${cardHeaderOf(row.content).title}`, `merged:${row.subject}`);
      }
    }
    if (!view || !turn) return [];
    const out: Creation[] = [];
    for (const dest of dests) {
      const existing = rows.find((row) => row.receiveId === dest.receiveId && row.kind === turn.kind && row.subject === turn.generation);
      if (!existing) out.push({ view: view as Creation["view"], dest });
      else if (existing.state === "resolved" && existing.resolution !== ACTED) await this.revive(existing, view as Creation["view"], dest, base);
    }
    return out;
  }

  /** 把一张卡收成说明文字。没发出去的直接作废，发出去的带按钮的卡排一次改卡。 */
  async resolve(row: OutboxRow, text: string, link: string | null, resolution = text): Promise<void> {
    const at = now();
    const patchable = row.state === "sent" && row.messageId && row.kind !== "verify_failed";
    await db.update(imOutbox).set({
      state: "resolved",
      resolution,
      resolvedAt: at,
      updatedAt: at,
      ...(patchable ? { content: JSON.stringify(renderCard(settledCard(cardHeaderOf(row.content), text, { link }))), patchState: "pending" } : {}),
    }).where(eq(imOutbox.id, row.id));
  }

  private async revive(row: OutboxRow, view: Creation["view"], dest: Destination, base: string | null): Promise<void> {
    const options = await readOptions();
    const content = await this.cardFor(row.id, view, dest, base, options.titleOnlyProjectIds);
    await db.update(imOutbox).set({
      state: row.messageId ? "sent" : "pending",
      content,
      resolution: null,
      resolvedAt: null,
      patchState: row.messageId ? "pending" : null,
      updatedAt: now(),
    }).where(eq(imOutbox.id, row.id));
  }

  private async cardFor(rowId: string, view: Creation["view"], dest: Destination, base: string | null, titleOnly: string[]): Promise<string> {
    const turn = view.turn;
    const payload: Record<string, unknown> =
      turn.kind === "question" ? { questionKey: turn.questionKey, options: turn.items[0]?.options ?? [], count: turn.items.length }
        : turn.kind === "dispute" ? { runId: turn.runId, round: turn.round }
          : turn.kind === "duet_gate" ? { version: turn.version }
            : turn.kind === "accept" ? { reviewFailed: turn.reviewFailed }
              : {};
    const envelope = DECISION_KINDS.has(turn.kind)
      ? await createEnvelope({ outboxId: rowId, taskId: view.task.id, action: turn.kind, payload, recipientOpenId: dest.recipientOpenId, generation: turn.generation })
      : "";
    const ctx = { link: taskLink(base, view), titleOnly: titleOnly.includes(view.task.projectId) };
    return JSON.stringify(renderCard(turnCard(view, turn, ctx, envelope, await extrasFor(view))));
  }

  private async create(creations: Creation[], base: string | null, titleOnly: string[]): Promise<void> {
    const byDest = new Map<string, Creation[]>();
    for (const item of creations) byDest.set(item.dest.receiveId, [...(byDest.get(item.dest.receiveId) ?? []), item]);
    for (const items of byDest.values()) {
      const flood = items.length > FLOOD_LIMIT;
      for (const { view, dest } of items) {
        const rowId = nanoid(20);
        const content = await this.cardFor(rowId, view, dest, base, titleOnly);
        await this.insert({ id: rowId, dest, taskId: view.task.id, kind: view.turn.kind, subject: view.turn.generation, content, state: flood ? "held" : "pending" });
      }
      if (flood) await this.summarize(items[0]!.dest);
    }
  }

  async insert(input: {
    id?: string; dest: Destination; taskId: string | null; kind: string; subject: string; content: string;
    state?: string; msgType?: "interactive" | "text"; replyTo?: string | null; replyInThread?: boolean;
  }): Promise<string> {
    const at = now();
    const id = input.id ?? nanoid(20);
    await db.insert(imOutbox).values({
      id,
      channel: "feishu",
      appId: this.appId,
      receiveType: input.dest.receiveType,
      receiveId: input.dest.receiveId,
      recipientOpenId: input.dest.recipientOpenId,
      taskId: input.taskId,
      kind: input.kind,
      subject: input.subject,
      replyTo: input.replyTo ?? null,
      replyInThread: input.replyInThread ? 1 : 0,
      msgType: input.msgType ?? "interactive",
      content: input.content,
      state: input.state ?? "pending",
      createdAt: at,
      updatedAt: at,
    }).onConflictDoNothing();
    return id;
  }

  /** 一条附在原卡下面的文字通知（回复那张卡，手机上会有提醒，原卡改动不会）。 */
  private async notice(row: OutboxRow, text: string, subject: string): Promise<void> {
    await this.insert({
      dest: { receiveType: row.receiveType as Destination["receiveType"], receiveId: row.receiveId, recipientOpenId: row.recipientOpenId },
      taskId: row.taskId, kind: "notice", subject, msgType: "text", content: JSON.stringify({ text }), replyTo: row.messageId,
    });
  }

  /** 给这个收件人发一张「有 N 件事在等你」的汇总（列出全部 held 的卡）。 */
  async summarize(dest: Destination): Promise<void> {
    const held = await db.select().from(imOutbox).where(and(
      eq(imOutbox.appId, this.appId), eq(imOutbox.receiveId, dest.receiveId), eq(imOutbox.state, "held"),
    )).orderBy(desc(imOutbox.createdAt));
    if (!held.length) return;
    const rowId = nanoid(20);
    const envelope = await createEnvelope({ outboxId: rowId, taskId: null, action: "summary", recipientOpenId: dest.recipientOpenId, generation: "summary" });
    const items = held.map((row) => {
      const header = cardHeaderOf(row.content);
      return { title: header.title, kind: row.kind as Turn["kind"], projectName: header.subtitle?.split(" · ")[0] ?? "" };
    });
    await this.insert({ id: rowId, dest, taskId: null, kind: "summary", subject: `s:${Date.now()}`, content: JSON.stringify(renderCard(summaryCard(items, envelope))) });
  }

  /** 把这个收件人 held 的卡放出去几张（/todo、汇总卡上的按钮）。返回放了几张、还剩几张。 */
  async release(receiveId: string, limit = FLOOD_LIMIT): Promise<{ released: number; left: number }> {
    const held = await db.select({ id: imOutbox.id }).from(imOutbox).where(and(
      eq(imOutbox.appId, this.appId), eq(imOutbox.receiveId, receiveId), eq(imOutbox.state, "held"),
    )).orderBy(desc(imOutbox.createdAt));
    const picked = held.slice(0, limit).map((row) => row.id);
    if (picked.length) {
      await db.update(imOutbox).set({ state: "pending", updatedAt: now() }).where(inArray(imOutbox.id, picked));
      this.sender.kick();
    }
    return { released: picked.length, left: held.length - picked.length };
  }
}

async function recentGateFailure(taskId: string, since: string | null): Promise<boolean> {
  const run = (await db.select({ status: acceptGateRuns.status }).from(acceptGateRuns).where(and(
    eq(acceptGateRuns.taskId, taskId), ne(acceptGateRuns.status, "running"), ...(since ? [gt(acceptGateRuns.startedAt, since)] : []),
  )).orderBy(desc(acceptGateRuns.startedAt)).limit(1)).at(0);
  return run?.status === "failed";
}

/** 旧卡收起来时写的那一句：照实说「为什么这张卡不用再点了」。 */
async function resolutionText(row: OutboxRow, view: TaskView | null): Promise<string> {
  if (!view) return "任务已删除。";
  const task = view.task;
  if (task.archived) return "任务已归档。";
  if (task.handoff?.direction === "out") return "任务已接力到另一台机器。";
  if (row.kind === "accept" && isAcceptedStage(task.stage)) return "已验收合并。";
  const next = view.turn;
  if (next && next.kind === row.kind) return row.kind === "question" ? "问题已更新，请看新的那张卡。" : "有了新的一轮，请看新的那张卡。";
  if (next) return `下一步变成了「${KIND_LABEL[next.kind]}」，请看新的那张卡。`;
  const live = task.status === "running" || task.status === "queued" || task.status === "awaiting_review";
  switch (row.kind) {
    case "question": return live ? "已答复，任务继续在跑。" : "已在别处答复。";
    case "failed": return live ? "已重试，任务在跑。" : "已在别处处理。";
    case "dispute": return "驳回已裁定。";
    case "duet_gate": return "闸口已在别处处理。";
    case "accept":
      if (live && await recentGateFailure(task.id, row.sentAt)) return "验收前置命令没通过，已交回任务修复。";
      return live ? "任务又开始跑了。" : "已在别处处理。";
    default: return "已处理。";
  }
}
