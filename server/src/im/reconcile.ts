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
//
// 「同一代」只说明还是那件事，不说明卡片内容还对：标题改了、项目改成只推标题、深链换了，代次都
// 不变。所以每张决策卡还记一个渲染指纹（render_key），对不上就原地重渲染（没发的直接换内容，
// 发出去的排一次改卡）。发件、改卡前再核一次（exits.ts）：排队期间授权或隐私设置变了的，不按旧样子发。
import { createHash } from "node:crypto";
import { isAcceptedStage } from "@ash/shared";
import { and, desc, eq, gt, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../db/index.js";
import type { ConclusionTransaction } from "../regression-conclusion-commit.js";
import { acceptGateRuns } from "../db/schema-accept-gate.js";
import { imActions, imOutbox } from "../db/schema-im.js";
import { tasks } from "../db/schema.js";
import { openDisputeTargets } from "../free-review-dispute.js";
import { now } from "../util.js";
import { DECISION_KINDS, viewsOf, withTeamLeads, type TaskView, type Turn } from "./attention.js";
import { KIND_LABEL, settledCard, summaryCard, taskLink, turnCard } from "./cards.js";
import { createEnvelope } from "./envelopes.js";
import { OutboxExits, summaryItems } from "./exits.js";
import { extrasFor } from "./extras.js";
import type { FeishuApi } from "./feishu/api.js";
import { renderCard } from "./feishu/cards.js";
import { readOptions } from "./meta.js";
import { advanceOutcomes, forgetOutcomes, outcomesOf, outcomesRecorded, staleOutcomeTasks } from "./outcomes.js";
import { cardHeaderOf, OutboxSender, type Destination, type OutboxRow } from "./outbox.js";
import { destinationsFor } from "./recipients.js";
import { scopeFor, type OutboxScope } from "./scope.js";

export const FLOOD_LIMIT = 5;
export const TURN_KINDS = ["question", "failed", "dispute", "duet_gate", "verify_failed", "accept"] as const;
const OPEN_STATES = ["pending", "sent", "held"];
/** 卡片被点过、结果已回写（不许被对账「复活」成原样）。 */
export const ACTED = "acted";
const BATCH = 40;
/** 改卡标记：已经排着结果回写（result / acking）的不降级成受额度约束的 pending。 */
const REPATCH = sql`CASE WHEN ${imOutbox.patchState} IN ('result', 'acking') THEN 'result' ELSE 'pending' END`;

type Clock = ConstructorParameters<typeof OutboxSender>[3];

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

  readonly sender: OutboxSender;
  readonly exits: OutboxExits;
  readonly turnKinds: readonly string[] = TURN_KINDS;

  constructor(readonly appId: string, api: FeishuApi, clock?: Clock) {
    this.exits = new OutboxExits(this);
    this.sender = new OutboxSender(api, appId, this.exits, clock);
  }

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
    const ids = [...new Set([...candidates.map((row) => row.id), ...open.map((row) => row.id!), ...disputes, ...await staleOutcomeTasks(this.appId)])];
    await this.run(() => this.reconcile(ids));
  }

  async reconcile(taskIds: string[]): Promise<void> {
    const ids = await withTeamLeads(taskIds);
    const options = await readOptions();
    const creations: Creation[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const views = await viewsOf(ids.slice(i, i + BATCH));
      for (const [taskId, view] of views) {
        creations.push(...await this.settleTask(taskId, view, options.publicBaseUrl, options.titleOnlyProjectIds));
        await this.announce(taskId, view, options.notifyCompleted);
      }
    }
    await this.create(creations, options.publicBaseUrl, options.titleOnlyProjectIds);
    this.sender.kick();
  }

  /** 对一个任务：收掉对不上的卡，返回该新推的。 */
  private async settleTask(
    taskId: string, view: TaskView | null, base: string | null, titleOnly: string[],
  ): Promise<Creation[]> {
    const turn = view?.turn ?? null;
    const dests = view && turn ? await destinationsFor(this.appId, view) : [];
    const rows = await db.select().from(imOutbox).where(and(
      eq(imOutbox.appId, this.appId), eq(imOutbox.taskId, taskId), inArray(imOutbox.kind, [...TURN_KINDS]),
    ));
    for (const row of rows) {
      if (!OPEN_STATES.includes(row.state)) continue;
      const dest = turn && row.kind === turn.kind && row.subject === turn.generation ? dests.find((d) => d.receiveId === row.receiveId) : undefined;
      if (dest) {
        await this.refresh(row, view as Creation["view"], dest, base, titleOnly);
        continue;
      }
      const text = await resolutionText(row, view);
      await this.resolve(row, text, view ? taskLink(base, view) : null);
    }
    if (!view || !turn) return [];
    const out: Creation[] = [];
    for (const dest of dests) {
      const existing = rows.find((row) => row.receiveId === dest.receiveId && row.kind === turn.kind && row.subject === turn.generation);
      if (!existing) out.push({ view: view as Creation["view"], dest });
      else if (existing.state === "resolved" && existing.resolution !== ACTED) await this.revive(existing, view as Creation["view"], dest, base, titleOnly);
    }
    return out;
  }

  /**
   * 把一张卡收成说明文字。库里一律换成收好的样子 —— 正在发的那一张发完会照库里这份改过去
   * （outbox.ts sendOne）；已经发出去的带按钮的卡排一次改卡；还没发的就此作废。
   */
  async resolve(row: OutboxRow, text: string, link: string | null, resolution = text): Promise<void> {
    const at = now();
    const patchable = row.state === "sent" && row.messageId && row.kind !== "verify_failed";
    await db.update(imOutbox).set({
      state: "resolved",
      resolution,
      resolvedAt: at,
      updatedAt: at,
      content: JSON.stringify(renderCard(settledCard(cardHeaderOf(row.content), text, { link }))),
      brief: null,
      ...(patchable ? { patchState: REPATCH, nextAt: null } : {}),
    }).where(eq(imOutbox.id, row.id));
  }

  private async revive(row: OutboxRow, view: Creation["view"], dest: Destination, base: string | null, titleOnly: string[]): Promise<void> {
    const envelope = await this.envelopeFor(row.id, view, dest);
    const { content, renderKey } = await this.render(view, dest, envelope, base, titleOnly);
    await db.update(imOutbox).set({
      state: row.messageId ? "sent" : "pending",
      content,
      renderKey,
      brief: null,
      scope: JSON.stringify(await this.turnScope(view, dest)),
      resolution: null,
      resolvedAt: null,
      patchState: row.messageId ? REPATCH : null,
      nextAt: null,
      updatedAt: now(),
    }).where(eq(imOutbox.id, row.id));
  }

  /** 决策卡的授权来源：这个任务；收件去处按此刻那一次绑定盖章。 */
  private turnScope(view: Creation["view"], dest: Destination): Promise<OutboxScope> {
    return scopeFor(this.appId, dest, { kind: "task", taskId: view.task.id });
  }

  /** 还是同一件事、同一个收件人：渲染输入变了就原地重渲染（信封沿用，按钮照样有效）。 */
  private async refresh(row: OutboxRow, view: Creation["view"], dest: Destination, base: string | null, titleOnly: string[]): Promise<void> {
    if (row.renderKey === renderKeyOf(view, dest, base, titleOnly)) return;
    let envelope = "";
    if (DECISION_KINDS.has(view.turn.kind)) {
      const latest = (await db.select({ id: imActions.id, usedAt: imActions.usedAt }).from(imActions)
        .where(and(eq(imActions.outboxId, row.id), eq(imActions.action, view.turn.kind)))
        .orderBy(desc(imActions.createdAt)).limit(1)).at(0);
      // 按钮已经点下去了（正在办，或者卡上正显示着办的结果）：卡面归那一下管，不拿原样盖掉它。
      if (latest?.usedAt) return;
      envelope = latest?.id ?? await this.envelopeFor(row.id, view, dest);
    }
    const { content, renderKey } = await this.render(view, dest, envelope, base, titleOnly);
    await db.update(imOutbox).set({
      content,
      renderKey,
      brief: null,
      scope: JSON.stringify(await this.turnScope(view, dest)),
      updatedAt: now(),
      ...(row.state === "sent" && row.messageId ? { patchState: REPATCH, nextAt: null } : {}),
    }).where(eq(imOutbox.id, row.id));
  }

  private async envelopeFor(rowId: string, view: Creation["view"], dest: Destination): Promise<string> {
    const turn = view.turn;
    if (!DECISION_KINDS.has(turn.kind)) return "";
    const payload: Record<string, unknown> =
      turn.kind === "question" ? { questionKey: turn.questionKey, options: turn.items[0]?.options ?? [], count: turn.items.length }
        : turn.kind === "dispute" ? { runId: turn.runId, round: turn.round }
          : turn.kind === "duet_gate" ? { version: turn.version }
            : turn.kind === "accept" ? { reviewFailed: turn.reviewFailed }
              : {};
    return createEnvelope({ outboxId: rowId, taskId: view.task.id, action: turn.kind, payload, recipientOpenId: dest.recipientOpenId, generation: turn.generation });
  }

  private async render(
    view: Creation["view"], dest: Destination, envelope: string, base: string | null, titleOnly: string[],
  ): Promise<{ content: string; renderKey: string }> {
    const ctx = { link: taskLink(base, view), titleOnly: titleOnly.includes(view.task.projectId) };
    return {
      content: JSON.stringify(renderCard(turnCard(view, view.turn, ctx, envelope, await extrasFor(view)))),
      renderKey: renderKeyOf(view, dest, base, titleOnly),
    };
  }

  private async create(creations: Creation[], base: string | null, titleOnly: string[]): Promise<void> {
    const byDest = new Map<string, Creation[]>();
    for (const item of creations) byDest.set(item.dest.receiveId, [...(byDest.get(item.dest.receiveId) ?? []), item]);
    for (const items of byDest.values()) {
      const flood = items.length > FLOOD_LIMIT;
      for (const { view, dest } of items) {
        const rowId = nanoid(20);
        const envelope = await this.envelopeFor(rowId, view, dest);
        const { content, renderKey } = await this.render(view, dest, envelope, base, titleOnly);
        const inserted = await this.insert({
          id: rowId, dest, taskId: view.task.id, kind: view.turn.kind, subject: view.turn.generation, content, renderKey, state: flood ? "held" : "pending",
          scope: await this.turnScope(view, dest),
        });
        // settleTask 已经确认这一格是空的：还撞上唯一键就是键与查询的口径不一致，不能当作已入队。
        if (!inserted) console.warn(`[ash] 飞书卡片入队被同键旧记录挡住（${view.turn.kind} ${view.task.id} → ${dest.receiveId}）`);
      }
      if (flood) await this.summarize(items[0]!.dest);
    }
  }

  /**
   * 入队。返回 null = 同键（应用、收件人、任务、种类、代次）已经有一行 —— 回执与通知靠这个幂等。
   * scope 必填（发件授权，scope.ts）；brief = 只推标题时换上的那一版；tx = 和别的写放进同一个事务。
   */
  async insert(input: {
    id?: string; dest: Destination; taskId: string | null; kind: string; subject: string; content: string; renderKey?: string;
    state?: string; msgType?: "interactive" | "text"; replyTo?: string | null; replyInThread?: boolean;
    scope: OutboxScope; brief?: string | null;
  }, tx?: ConclusionTransaction): Promise<string | null> {
    const at = now();
    const id = input.id ?? nanoid(20);
    const rows = await (tx ?? db).insert(imOutbox).values({
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
      renderKey: input.renderKey ?? null,
      scope: JSON.stringify(input.scope),
      brief: input.brief ?? null,
      state: input.state ?? "pending",
      createdAt: at,
      updatedAt: at,
    }).onConflictDoNothing().returning({ id: imOutbox.id });
    return rows.length ? id : null;
  }

  /**
   * 验收合并、门禁出结果：按结局账（outcomes.ts）的变化各发一条新的文字通知（手机上会提醒，改卡不会），
   * 有这个人的待验收卡就回复在它下面。账总是跟着改（开关关着也改），开关再打开时不补推关着期间的结局；
   * 执行者、归档、接力出去的任务只记账不发。
   */
  private async announce(taskId: string, view: TaskView | null, notifyCompleted: boolean): Promise<void> {
    if (!view) return forgetOutcomes(this.appId, taskId);
    const current = await outcomesOf(view);
    if (await outcomesRecorded(this.appId, taskId, current)) return;
    const quiet = !notifyCompleted || view.teamWorker || view.task.archived || view.task.handoff?.direction === "out";
    const targets: { dest: Destination; scope: OutboxScope; replyTo: string | null }[] = [];
    for (const dest of quiet ? [] : await destinationsFor(this.appId, view)) {
      const card = (await db.select({ messageId: imOutbox.messageId }).from(imOutbox).where(and(
        eq(imOutbox.appId, this.appId), eq(imOutbox.taskId, taskId), eq(imOutbox.receiveId, dest.receiveId),
        eq(imOutbox.kind, "accept"), isNotNull(imOutbox.messageId),
      )).orderBy(desc(imOutbox.createdAt)).limit(1)).at(0);
      targets.push({ dest, scope: await scopeFor(this.appId, dest, { kind: "task", taskId }), replyTo: card?.messageId ?? null });
    }
    await db.transaction(async (tx) => {
      for (const outcome of await advanceOutcomes(tx, this.appId, taskId, current)) {
        for (const { dest, scope, replyTo } of targets) {
          await this.insert({
            dest, taskId, kind: "notice", subject: `${outcome.kind}:${outcome.value}`, msgType: "text",
            content: JSON.stringify({ text: outcome.text }), replyTo, scope,
          }, tx);
        }
      }
    }, { behavior: "immediate" });
  }

  /** 给这个收件人发一张「有 N 件事在等你」的汇总（列出全部 held 的卡）。 */
  async summarize(dest: Destination): Promise<void> {
    const held = await db.select().from(imOutbox).where(and(
      eq(imOutbox.appId, this.appId), eq(imOutbox.receiveId, dest.receiveId), eq(imOutbox.state, "held"),
    )).orderBy(desc(imOutbox.createdAt));
    if (!held.length) return;
    const rowId = nanoid(20);
    const envelope = await createEnvelope({ outboxId: rowId, taskId: null, action: "summary", recipientOpenId: dest.recipientOpenId, generation: "summary" });
    await this.insert({
      id: rowId, dest, taskId: null, kind: "summary", subject: `s:${Date.now()}`, content: JSON.stringify(renderCard(summaryCard(summaryItems(held), envelope))),
      scope: await scopeFor(this.appId, dest, { kind: "digest", rowIds: held.map((row) => row.id) }),
    });
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

/**
 * 决策卡的渲染输入指纹。只收会改变卡面、又不改变代次的那几样；出错提示、闸口结论这类现读的补充
 * 在同一代里不会变，不算进来（算进来就得每次对账都去读 trace）。
 */
export function renderKeyOf(view: Creation["view"], dest: Destination, base: string | null, titleOnly: string[]): string {
  const input = JSON.stringify([
    view.task.title, view.projectName, view.turn, dest.receiveType, taskLink(base, view), titleOnly.includes(view.task.projectId),
  ]);
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
