// 卡片按钮的回调。
//
// 飞书要求 3 秒内回应，回应里可以直接带一张新卡（不花 API 额度、P0 实测会就地生效）。所以：
//   · 快的动作（答复、重试、裁定、闸口）当场做完，结果卡随回应带回去；
//   · 慢的（验收要合并、可能还要跑十几分钟的前置命令、建任务）先回一张「处理中」，做完再改卡
//     （这一次改卡记 result 用途，额度见底也照发）。
// 决策卡和 /new、/stop 的确认卡走同一条路：限时回执、异步收尾、没办成就把原卡改回去能再点。
// 校验顺序见 envelopes.ts 顶部；第④关（是不是还是那件事）在这里现算。
//
// 进程在「信封已占用、结果没写」之间退出：重启后 recover() 按现状判那一下办成没有（见那里）。
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { imInbound, imOutbox } from "../db/schema-im.js";
import { appendTaskTimeline } from "../task-timeline.js";
import { noteSystemNotice } from "../user-action-rejection.js";
import { now } from "../util.js";
import { imActorFor, type ImPrincipal } from "../auth/im-actor.js";
import { viewsOf, type TaskView } from "./attention.js";
import { taskPath, type AshClient, type AshResult } from "./ash-client.js";
import { CHANNEL } from "./binding.js";
import { settledCard, taskLink } from "./cards.js";
import {
  checkEnvelope, claimEnvelope, finishEnvelope, releaseEnvelope, unfinishedEnvelopes, type EnvelopeRow,
} from "./envelopes.js";
import { renderCard, type CardTone } from "./feishu/cards.js";
import { readOptions } from "./meta.js";
import { cardHeaderOf, type OutboxRow, type OutboxSender } from "./outbox.js";
import { ACTED, type Reconciler } from "./reconcile.js";
import { scrubText } from "./scrub.js";
import type { CommandRunner } from "./commands.js";

export interface CallbackEvent {
  eventId: string;
  operatorOpenId: string;
  value: Record<string, unknown>;
  formValue: Record<string, unknown>;
  name: string | null;
}

export interface CallbackResponse {
  toast?: { type: "success" | "error" | "info" | "warning"; content: string };
  card?: { type: "raw"; data: Record<string, unknown> };
}

/** 一次动作的结局。final = 这张卡的事办完了（收起来，不许再被对账复活）。 */
export interface Outcome {
  ok: boolean;
  text: string;
  final: boolean;
  tone?: CardTone;
  /** 写进任务时间线的那一句（不写 = 不记）。 */
  audit?: string;
  /** 结果卡上「在 ash 中打开」指向哪里（缺省用这张卡原来的任务）。 */
  link?: string | null;
}

/** 一次点击要做的事，和结果卡挂在哪个任务上（确认卡 /new 没有任务）。 */
interface Job {
  run: () => Promise<Outcome>;
  taskId: string | null;
  link: string | null;
}

const FAST_MS = 2_400;
const toast = (type: NonNullable<CallbackResponse["toast"]>["type"], content: string): CallbackResponse => ({ toast: { type, content } });

const REJECT_TEXT: Record<string, string> = {
  missing: "按钮已失效（卡片太旧或已被替换），请在 ash 里处理",
  expired: "卡片已过期，请在 ash 里处理",
  not_yours: "这张卡片不是发给你的",
  used: "这张卡片已经处理过了",
};

export class CardActions {
  constructor(private readonly deps: {
    appId: string;
    ash: AshClient;
    reconciler: Reconciler;
    sender: OutboxSender;
    commands: CommandRunner;
  }) {}

  async handle(event: CallbackEvent): Promise<CallbackResponse> {
    const fresh = await db.insert(imInbound).values({
      id: `evt:${event.eventId}`, channel: CHANNEL, appId: this.deps.appId, openId: event.operatorOpenId,
      kind: "callback", state: "received", createdAt: now(), updatedAt: now(),
    }).onConflictDoNothing().returning({ id: imInbound.id });
    if (!fresh.length) return toast("info", "已收到");
    const envelopeId = typeof event.value.e === "string" ? event.value.e : "";
    const op = typeof event.value.op === "string" ? event.value.op : "";
    const check = await checkEnvelope(envelopeId, event.operatorOpenId);
    if (!check.ok) return toast(check.reason === "used" ? "info" : "error", REJECT_TEXT[check.reason]!);
    const principal: ImPrincipal = { channel: CHANNEL, appId: this.deps.appId, openId: event.operatorOpenId };
    const actor = await imActorFor(principal);
    if (!actor) return toast("error", "你还没绑定 ash（或绑定已失效）：请在 ash 网页 设置 → 飞书 里绑定");
    const row = (await db.select().from(imOutbox).where(eq(imOutbox.id, check.envelope.outboxId))).at(0);
    if (!row) return toast("error", REJECT_TEXT.missing!);

    if (check.envelope.action === "summary") {
      if (op !== "push") return toast("error", "认不出这个按钮");
      const { released, left } = await this.deps.reconciler.run(() => this.deps.reconciler.release(row.receiveId));
      return toast("success", released ? `推送了 ${released} 张${left ? `，还剩 ${left} 张，再点一次继续` : ""}` : "没有积压的卡了");
    }
    const job = check.envelope.action === "confirm"
      ? this.confirmJob(check.envelope, check.payload, op, principal)
      : await this.turnJob(check.envelope, check.payload, op, event, row);
    if (!("run" in job)) return job;
    if (!await claimEnvelope(envelopeId)) return toast("info", "这张卡片正在处理");

    const work = job.run().catch((error): Outcome => ({ ok: false, text: `出错了：${(error as Error).message}`, final: false }));
    const quick = await Promise.race([work, new Promise<null>((resolve) => { const t = setTimeout(() => resolve(null), FAST_MS); t.unref?.(); })]);
    if (quick) return this.settle(quick, check.envelope, row, job, actor.name, "callback");
    const processing = renderCard(settledCard(cardHeaderOf(row.content), "处理中…结果出来会更新在这张卡上。", { link: job.link }, "wathet"));
    void work.then((outcome) => this.settle(outcome, check.envelope, row, job, actor.name, "patch"))
      .catch((error) => console.error("[ash] 飞书按钮异步收尾出错:", error));
    return { toast: { type: "info", content: "处理中" }, card: { type: "raw", data: processing } };
  }

  /** 任务决策卡：先核第④关，旧卡顺手收起来。返回回应 = 这一下不执行。 */
  private async turnJob(
    envelope: EnvelopeRow, payload: Record<string, unknown>, op: string, event: CallbackEvent, row: OutboxRow,
  ): Promise<Job | CallbackResponse> {
    const view = (await viewsOf([envelope.taskId ?? ""])).get(envelope.taskId ?? "") ?? null;
    const link = view ? taskLink((await readOptions()).publicBaseUrl, view) : null;
    if (!view?.turn || view.turn.kind !== envelope.action || view.turn.generation !== envelope.generation) {
      // 旧卡：顺手把它收起来，回应里带上收好的样子。
      const text = !view ? "任务已删除。" : "这张卡已经过时：事情已在别处处理，或者有了新的一轮。";
      await this.deps.reconciler.run(() => this.deps.reconciler.resolve(row, text, link, ACTED));
      this.deps.reconciler.mark(envelope.taskId ?? "");
      return { toast: { type: "warning", content: "这张卡已经过时" }, card: { type: "raw", data: renderCard(settledCard(cardHeaderOf(row.content), text, { link })) } };
    }
    const prepared = this.prepare(view, envelope.action, op, payload, event);
    if (typeof prepared === "string") return toast("warning", prepared);
    return { run: prepared, taskId: view.task.id, link };
  }

  /** /new、/stop 的确认卡。 */
  private confirmJob(envelope: EnvelopeRow, payload: Record<string, unknown>, op: string, principal: ImPrincipal): Job | CallbackResponse {
    if (op === "cancel") return { run: async () => ({ ok: true, text: "已取消。", final: true, tone: "grey" }), taskId: null, link: null };
    if (op !== "confirm") return toast("error", "认不出这个按钮");
    return { run: () => this.deps.commands.confirmed(principal, payload), taskId: envelope.taskId, link: null };
  }

  /**
   * 上一次运行里点下去、没办完的按钮（进程在执行途中退出）。不能一股脑放回去 —— 办成了的再点一遍
   * 就是重复执行；也不能一直挂着「已经处理过了」。按现状判：
   *   · 决策卡：事情还停在点之前（同一件事、同一代）= 那一下没生效，放回去能再点，卡面改回原样
   *     （可能正停在「处理中」）；已经变了 = 办成了（或别处处理了），记完、交给对账收卡。
   *     再点一遍也不会重复执行：答复带 questionKey、裁定带轮次、闸口带版本号，接口都按 CAS 判。
   *   · 确认卡：建任务 / 停任务办没办成从现状认不出来，记成中断，照实告诉用户。
   */
  async recover(): Promise<number> {
    const stuck = await unfinishedEnvelopes();
    for (const envelope of stuck) {
      const row = (await db.select().from(imOutbox).where(eq(imOutbox.id, envelope.outboxId))).at(0) ?? null;
      if (envelope.action === "confirm") {
        await finishEnvelope(envelope.id, "interrupted");
        if (!row) continue;
        const text = "点下「确定」时 ash 正好重启，不确定办成没有：请在 ash 里看一眼，需要的话重新发命令。";
        const card = renderCard(settledCard(cardHeaderOf(row.content), text, { link: null }, "orange"));
        await this.deps.reconciler.run(async () => {
          await db.update(imOutbox).set({
            state: "resolved", resolution: ACTED, content: JSON.stringify(card), resolvedAt: now(), updatedAt: now(),
            ...(row.messageId ? { patchState: "result" } : {}),
          }).where(eq(imOutbox.id, row.id));
        });
        continue;
      }
      const view = envelope.taskId ? (await viewsOf([envelope.taskId])).get(envelope.taskId) ?? null : null;
      if (view?.turn && view.turn.kind === envelope.action && view.turn.generation === envelope.generation) {
        await releaseEnvelope(envelope.id, "interrupted");
        if (row?.messageId) await this.restore(row);
      } else {
        await finishEnvelope(envelope.id, "interrupted");
      }
      if (envelope.taskId) this.deps.reconciler.mark(envelope.taskId);
    }
    if (stuck.length) this.deps.sender.kick();
    return stuck.length;
  }

  /** 卡面换回库里那份（原卡，或对账刚重渲染 / 收起的样子），盖掉「处理中」。 */
  private async restore(row: OutboxRow): Promise<void> {
    await this.deps.reconciler.run(async () => {
      await db.update(imOutbox).set({ patchState: "result", updatedAt: now() }).where(eq(imOutbox.id, row.id));
    });
  }

  /** 校验输入、拼好要调的接口。返回字符串 = 输入不对（不占用信封，改了还能再点）。 */
  private prepare(view: TaskView, kind: string, op: string, payload: Record<string, unknown>, event: CallbackEvent): string | (() => Promise<Outcome>) {
    const principal: ImPrincipal = { channel: CHANNEL, appId: this.deps.appId, openId: event.operatorOpenId };
    const id = view.task.id;
    const ash = this.deps.ash;
    const form = (key: string) => (typeof event.formValue[key] === "string" ? (event.formValue[key] as string).trim() : "");
    switch (kind) {
      case "question": {
        const count = Number(payload.count) || 1;
        const options = Array.isArray(payload.options) ? payload.options as string[] : [];
        let body: Record<string, unknown>;
        let shown: string;
        if (op === "opt") {
          const option = options[Number(event.value.i)];
          if (typeof option !== "string") return "这个选项已经不在了";
          body = { answer: option };
          shown = option;
        } else if (op === "answer") {
          const answers = Array.from({ length: count }, (_, index) => form(`a${index}`));
          if (!answers.some(Boolean)) return "写点什么再提交";
          body = count === 1 ? { answer: answers[0] } : { answers };
          shown = count === 1 ? answers[0]! : answers.map((answer, index) => `${index + 1}. ${answer || "（未答）"}`).join("\n");
        } else return "认不出这个按钮";
        return async () => outcomeOf(await ash.post(principal, taskPath(id, "/answer"), { ...body, questionKey: payload.questionKey }),
          `已答复：${scrubText(shown, 300)}`, "答复了提问");
      }
      case "failed":
        if (op !== "retry") return "认不出这个按钮";
        return async () => outcomeOf(await ash.post(principal, taskPath(id, "/retry")), "已重试，任务重新开始跑了。", "点了「重试」");
      case "dispute": {
        const labels: Record<string, string> = { upheld: "让它接着改", withdrawn: "这一轮不用改了", deferred: "转为独立任务" };
        if (!labels[op]) return "认不出这个按钮";
        return async () => outcomeOf(await ash.post(principal, taskPath(id, "/free-workflow/review/dispute/resolution"), {
          resolution: op, target: { runId: payload.runId, round: payload.round },
        }), `已裁定：${labels[op]}。`, `裁定驳回为「${labels[op]}」`);
      }
      case "duet_gate": {
        const labels: Record<string, string> = { approve: "已放行。", reject: "已打回，讨论终止。", inject: "意见已注入，双方回炉。", ask: "问题已送出，答完继续。" };
        if (!labels[op]) return "认不出这个按钮";
        const text = form("text");
        if ((op === "inject" || op === "ask") && !text) return "先写下意见或问题";
        return async () => outcomeOf(await ash.post(principal, taskPath(id, "/gate"), {
          kind: op, ...(text && (op === "inject" || op === "ask") ? { text } : {}), expectedVersion: payload.version,
        }), labels[op]!, `在讨论闸口${{ approve: "放行", reject: "打回", inject: "注入意见", ask: "提问" }[op]}`);
      }
      case "accept":
        if (op !== "accept") return "认不出这个按钮";
        return async () => acceptOutcome(await ash.post(principal, taskPath(id, "/accept"), {}));
      default:
        return "认不出这个按钮";
    }
  }

  /** 把结局落到卡片和库里。via=callback 时随回应带回；patch 时排一次改卡。 */
  private async settle(
    outcome: Outcome, envelope: EnvelopeRow, row: OutboxRow, job: Job, actorName: string, via: "callback" | "patch",
  ): Promise<CallbackResponse> {
    const link = outcome.link !== undefined ? outcome.link : job.link;
    const card = renderCard(settledCard(cardHeaderOf(row.content), outcome.text, { link }, outcome.tone ?? (outcome.ok ? "green" : "red")));
    if (!outcome.ok) {
      if (via === "patch" && row.messageId) {
        // 「处理中」那张已经换上去了，用户看不到 toast：卡面改回原样、原因回复在卡片下面，最后才放回
        // 信封 —— 反过来的话，中间退出卡面就一直停在「处理中」（信封已经放回，recover 看不到它）。
        await this.restore(row);
        await this.deps.reconciler.run(() => this.deps.reconciler.insert({
          dest: { receiveType: row.receiveType as "open_id" | "chat_id", receiveId: row.receiveId, recipientOpenId: row.recipientOpenId },
          taskId: row.taskId, kind: "reply", subject: `fail:${envelope.id}:${Date.now()}`, msgType: "text",
          content: JSON.stringify({ text: `没办成：${outcome.text}` }), replyTo: row.messageId,
        }));
        this.deps.sender.kick();
      }
      await releaseEnvelope(envelope.id, outcome.text);
      if (via === "patch" && job.taskId) this.deps.reconciler.mark(job.taskId);
      return toast("error", outcome.text);
    }
    await finishEnvelope(envelope.id, outcome.text);
    await this.deps.reconciler.run(async () => {
      const at = now();
      await db.update(imOutbox).set({
        content: JSON.stringify(card),
        updatedAt: at,
        ...(outcome.final ? { state: "resolved", resolution: ACTED, resolvedAt: at } : {}),
        // 回调回应里已经带了新卡，就不必再改；异步收尾的那一路要改。
        patchState: via === "patch" ? "result" : "done",
      }).where(eq(imOutbox.id, row.id));
    });
    if (via === "patch") this.deps.sender.kick();
    if (outcome.audit && job.taskId) await audit(job.taskId, envelope.id, `经飞书（${actorName}）${outcome.audit}`);
    if (job.taskId) this.deps.reconciler.mark(job.taskId);
    return { toast: { type: "success", content: outcome.text.slice(0, 60) }, card: { type: "raw", data: card } };
  }
}

function outcomeOf(result: AshResult, text: string, audit: string): Outcome {
  if (result.ok) return { ok: true, text, final: true, audit };
  return { ok: false, text: scrubText(result.error, 300), final: false };
}

function acceptOutcome(result: AshResult): Outcome {
  if (result.ok) {
    const branch = typeof result.data.targetBranch === "string" ? `（合入 ${result.data.targetBranch}）` : "";
    return { ok: true, text: `已验收合并${branch}。`, final: true, audit: "点了「验收合并」" };
  }
  const reason = result.data.reason;
  if (reason === "accept_gate_running") {
    return {
      ok: true, final: false, tone: "wathet", audit: "点了「验收合并」，验收前置命令开始跑",
      text: "验收前置命令在跑（可能要十几分钟）。跑完是绿的会自动合并，结果出来会更新这张卡。",
    };
  }
  if (reason === "accept_gate_failed") {
    return { ok: true, final: true, tone: "red", audit: "点了「验收合并」，验收前置命令没通过", text: `验收前置命令没通过，日志已交回任务修复。\n${scrubText(result.error, 400)}` };
  }
  if (reason === "verify_not_run") return { ok: false, final: false, text: "独立验证还没跑：要不等验证、直接验收，只能在 ash 页面上确认。" };
  return { ok: false, final: false, text: scrubText(result.error, 400) };
}

/** 时间线上留一笔「是从飞书点的」。任务还没有会话时退回系统提示。 */
async function audit(taskId: string, eventKey: string, text: string): Promise<void> {
  try {
    if (await appendTaskTimeline(taskId, text, { eventKey: `im:${eventKey}` })) return;
    await noteSystemNotice(taskId, `im:${eventKey}`, "飞书操作", text);
  } catch (error) {
    console.warn(`[ash] 飞书操作记入时间线失败（${taskId}）:`, (error as Error).message);
  }
}
