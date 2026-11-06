// 卡片按钮的回调。
//
// 飞书要求 3 秒内回应，回应里可以直接带一张新卡（不花 API 额度、P0 实测会就地生效）。所以：
//   · 快的动作（答复、重试、裁定、闸口）当场做完，结果卡随回应带回去；
//   · 慢的（验收要合并、可能还要跑十几分钟的前置命令、建任务）先回一张「处理中」，做完再改卡
//     （这一次改卡记 result 用途，额度见底也照发）。
// 决策卡和 /new、/stop 的确认卡走同一条路：限时回执、异步收尾、没办成就把原卡改回去能再点。
// 校验顺序见 envelopes.ts 顶部；第④关（是不是还是那件事）在这里现算。
//
// 结局只在一个事务里落（commit）：信封的结局 + 卡上该显示的样子 + 待改卡标记（+ 没办成时的原因回复）
// 一起提交，中间退出就整笔没发生、信封还是「已占用、没结果」，重启后 recover() 接管。结果卡随回执
// 带回去的那一路先记 acking：回执在时限内发出才算送到（channel.ts），没确认的过期后照样改一次卡。
// 回执里带回去的卡也过发件出口的同一个判据（exits.ts outward）。
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { imInbound, imOutbox } from "../db/schema-im.js";
import type { ConclusionTransaction } from "../regression-conclusion-commit.js";
import { appendTaskTimeline } from "../task-timeline.js";
import { noteSystemNotice } from "../user-action-rejection.js";
import { now } from "../util.js";
import type { Actor } from "../auth/context.js";
import { imActorFor, type ImPrincipal } from "../auth/im-actor.js";
import { canSeeProject } from "../auth/visibility.js";
import { versionOf, viewsOf, type TaskView } from "./attention.js";
import { taskPath, type AshClient, type AshResult } from "./ash-client.js";
import { CHANNEL } from "./binding.js";
import { settledCard, taskLink } from "./cards.js";
import {
  auditDone, checkEnvelope, claimEnvelope, claimOf, finishEnvelope, releaseEnvelope, unauditedEnvelopes, unfinishedEnvelopes,
  type Claim, type EnvelopeRow,
} from "./envelopes.js";
import { NEUTRAL_CONTENT } from "./exits.js";
import { renderCard, type CardTone } from "./feishu/cards.js";
import { readOptions } from "./meta.js";
import { cardHeaderOf, type Destination, type OutboxRow, type OutboxSender } from "./outbox.js";
import { ACTED, type Reconciler } from "./reconcile.js";
import { replyScope, scopeOfRow } from "./scope.js";
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
  /** 项目设成只推标题时卡上换成的那一句（text 里带着答复原文、出错原因时给）。 */
  brief?: string;
}

/** 一次点击要做的事，和结果卡挂在哪个任务上（确认卡 /new 没有任务）。 */
interface Job {
  run: () => Promise<Outcome>;
  taskId: string | null;
  link: string | null;
}

/** 这一下点击收尾要用到的全部现场。 */
interface Click { claim: Claim; row: OutboxRow; job: Job; actorName: string }

const FAST_MS = 2_400;
/** 结果卡随回执带回去之后，等「回执已发出」的确认这么久；过了还没确认就改一次卡。 */
const ACK_GRACE_MS = 15_000;
/** 收尾的事务没提交上（数据库忙等）：活着的进程里按这个节奏再试，不等重启。 */
const SETTLE_RETRY_MS = [1_000, 5_000, 30_000, 120_000];
const toast = (type: NonNullable<CallbackResponse["toast"]>["type"], content: string): CallbackResponse => ({ toast: { type, content } });
const sleep = (ms: number) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

const REJECT_TEXT: Record<string, string> = {
  missing: "按钮已失效（卡片太旧或已被替换），请在 ash 里处理",
  expired: "卡片已过期，请在 ash 里处理",
  not_yours: "这张卡片不是发给你的",
  used: "这张卡片已经处理过了",
};

/** 结局事务。只用 tx 写（根 db 的写会等这个事务收尾，事务里调它就卡死 5 秒再抛错）。 */
function commit<T>(reconciler: Reconciler, write: (tx: ConclusionTransaction) => Promise<T>): Promise<T> {
  return reconciler.run(() => db.transaction(write, { behavior: "immediate" }));
}

/** 卡面换回库里那份（原卡，或对账刚重渲染 / 收起的样子），盖掉「处理中」。改之前出口还会按现状再核。 */
async function restoreIn(tx: ConclusionTransaction, rowId: string): Promise<void> {
  await tx.update(imOutbox).set({ patchState: "result", nextAt: null, updatedAt: now() }).where(eq(imOutbox.id, rowId));
}

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
      : await this.turnJob(check.envelope, check.payload, op, event, row, actor);
    if (!("run" in job)) return job;
    const claim = await claimEnvelope(envelopeId);
    if (!claim) return toast("info", "这张卡片正在处理");
    const click: Click = { claim, row, job, actorName: actor.name };

    const work = job.run().catch((error): Outcome => ({ ok: false, text: `出错了：${scrubText((error as Error).message, 300)}`, final: false }));
    const quick = await Promise.race([work, new Promise<null>((resolve) => { const t = setTimeout(() => resolve(null), FAST_MS); t.unref?.(); })]);
    if (quick) return this.conclude(quick, click, "callback");
    const processing = await this.deps.reconciler.exits.outward(row,
      renderCard(settledCard(cardHeaderOf(row.content), "处理中…结果出来会更新在这张卡上。", { link: job.link }, "wathet")));
    void work.then((outcome) => this.conclude(outcome, click, "patch"))
      .catch((error) => console.error("[ash] 飞书按钮异步收尾出错:", error));
    return { toast: { type: "info", content: "处理中" }, card: { type: "raw", data: processing } };
  }

  /**
   * 任务决策卡：先核点的人还看不看得见这个任务（群里的卡谁都能点），再核第④关，旧卡顺手收起来。
   * 返回回应 = 这一下不执行。
   */
  private async turnJob(
    envelope: EnvelopeRow, payload: Record<string, unknown>, op: string, event: CallbackEvent, row: OutboxRow, actor: Actor,
  ): Promise<Job | CallbackResponse> {
    const view = (await viewsOf([envelope.taskId ?? ""])).get(envelope.taskId ?? "") ?? null;
    if (view && !await canSeeProject(actor, view.task.projectId)) return toast("error", "你看不到这个任务所在的项目，点不了这张卡");
    const link = view ? taskLink((await readOptions()).publicBaseUrl, view) : null;
    if (!view?.turn || view.turn.kind !== envelope.action || view.turn.generation !== envelope.generation) {
      // 旧卡：顺手把它收起来，回应里带上收好的样子。
      const text = !view ? "任务已删除。" : "这张卡已经过时：事情已在别处处理，或者有了新的一轮。";
      await this.deps.reconciler.run(() => this.deps.reconciler.resolve(row, text, link, ACTED));
      this.deps.reconciler.mark(envelope.taskId ?? "");
      const card = await this.deps.reconciler.exits.outward(row, renderCard(settledCard(cardHeaderOf(row.content), text, { link })));
      return { toast: { type: "warning", content: "这张卡已经过时" }, card: { type: "raw", data: card } };
    }
    const prepared = this.prepare(view, envelope, op, payload, event);
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
   *   · 决策卡：事情还停在点之前（同一件事、同一代）= 那一下没生效，放回去能再点；已经变了 = 办成了
   *     （或别处处理了），记完、交给对账收卡。再点一遍也不会重复执行：答复带题目的那一次（代次）、
   *     裁定带轮次、闸口带版本号，接口都在写入那一刻按条件判。
   *   · 确认卡：建任务 / 停任务办没办成从现状认不出来，记成中断，照实告诉用户。
   * 哪一支都把库里那份重新改上卡（可能正停在只随回执发过的「处理中」），和结局同一个事务。
   */
  async recover(): Promise<number> {
    const stuck = await unfinishedEnvelopes(this.deps.appId);
    for (const envelope of stuck) {
      // 一张出错不挡后面的（信封仍是「已占用、没结果」，下次启动再接）。
      try {
        await this.recoverOne(envelope);
      } catch (error) {
        console.error(`[ash] 飞书按钮 ${envelope.id} 收尾接管出错:`, error);
      }
    }
    // 办完了、时间线那一句还没记上的（记的途中退出了）：按同一个 eventKey 补记，记过的不会重复。
    for (const envelope of await unauditedEnvelopes(this.deps.appId)) {
      if (envelope.taskId && envelope.audit) await audit(envelope.taskId, envelope.id, envelope.audit);
    }
    if (stuck.length) this.deps.sender.kick();
    return stuck.length;
  }

  private async recoverOne(envelope: EnvelopeRow): Promise<void> {
    const claim = claimOf(envelope);
    const row = (await db.select().from(imOutbox).where(eq(imOutbox.id, envelope.outboxId))).at(0) ?? null;
    if (envelope.action === "confirm") {
      const text = "点下「确定」时 ash 正好重启，不确定办成没有：请在 ash 里看一眼，需要的话重新发命令。";
      const content = row ? JSON.stringify(renderCard(settledCard(cardHeaderOf(row.content), text, { link: null }, "orange"))) : null;
      await commit(this.deps.reconciler, async (tx) => {
        if (!await finishEnvelope(tx, claim, "interrupted") || !row || !content) return;
        await tx.update(imOutbox).set({
          state: "resolved", resolution: ACTED, content, brief: null, resolvedAt: now(), updatedAt: now(),
          ...(row.messageId ? { patchState: "result", nextAt: null } : {}),
        }).where(eq(imOutbox.id, row.id));
      });
      return;
    }
    const view = envelope.taskId ? (await viewsOf([envelope.taskId])).get(envelope.taskId) ?? null : null;
    const untouched = !!view?.turn && view.turn.kind === envelope.action && view.turn.generation === envelope.generation;
    await commit(this.deps.reconciler, async (tx) => {
      const concluded = untouched ? await releaseEnvelope(tx, claim, "interrupted") : await finishEnvelope(tx, claim, "interrupted");
      if (concluded && row?.messageId) await restoreIn(tx, row.id);
    });
    if (envelope.taskId) this.deps.reconciler.mark(envelope.taskId);
  }

  /** 校验输入、拼好要调的接口。返回字符串 = 输入不对（不占用信封，改了还能再点）。 */
  private prepare(
    view: TaskView, envelope: EnvelopeRow, op: string, payload: Record<string, unknown>, event: CallbackEvent,
  ): string | (() => Promise<Outcome>) {
    const principal: ImPrincipal = { channel: CHANNEL, appId: this.deps.appId, openId: event.operatorOpenId };
    const id = view.task.id;
    const ash = this.deps.ash;
    const form = (key: string) => (typeof event.formValue[key] === "string" ? (event.formValue[key] as string).trim() : "");
    switch (envelope.action) {
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
        // 答的是发卡时那一次提问（代次），不只是同一段题面：同样的题再问一次，旧卡上的按钮答不中新的那次。
        return async () => outcomeOf(await ash.post(principal, taskPath(id, "/answer"), {
          ...body, questionKey: payload.questionKey, questionOccurrence: envelope.generation,
        }), `已答复：${scrubText(shown, 300)}`, "答复了提问", "已答复。");
      }
      // 重试、验收带着卡上那一次失败 / 那一版成果进去（task-result-version.ts），接口占着互斥再核：
      // 点下去之前另一端又跑完一轮，旧卡就重试不了、验收不了后来那一版。
      case "failed":
        if (op !== "retry") return "认不出这个按钮";
        return async () => outcomeOf(await ash.post(principal, taskPath(id, "/retry"), { expectedFailure: versionOf(envelope.generation) }),
          "已重试，任务重新开始跑了。", "点了「重试」");
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
        return async () => acceptOutcome(await ash.post(principal, taskPath(id, "/accept"), { expectedResultVersion: versionOf(envelope.generation) }));
      default:
        return "认不出这个按钮";
    }
  }

  /** 收尾。事务没提交上（数据库忙等）：卡面交给后台按退避重试，回执先说「处理中」。 */
  private async conclude(outcome: Outcome, click: Click, via: "callback" | "patch"): Promise<CallbackResponse> {
    try {
      return await this.settle(outcome, click, via);
    } catch (error) {
      console.error("[ash] 飞书按钮收尾没落库，稍后重试:", error);
      void this.retrySettle(outcome, click);
      return toast("info", "处理中");
    }
  }

  private async retrySettle(outcome: Outcome, click: Click): Promise<void> {
    for (const ms of SETTLE_RETRY_MS) {
      await sleep(ms);
      try {
        await this.settle(outcome, click, "patch");
        return;
      } catch (error) {
        console.error("[ash] 飞书按钮收尾重试失败:", error);
      }
    }
    // 还不行就留给下次启动的 recover()（信封仍是「已占用、没结果」）。
  }

  /** 把结局落到卡片和库里（一个事务）。via=callback 时结果卡随回应带回；patch 时排一次改卡。 */
  private async settle(outcome: Outcome, click: Click, via: "callback" | "patch"): Promise<CallbackResponse> {
    const { claim, row, job } = click;
    const header = cardHeaderOf(row.content);
    const link = outcome.link !== undefined ? outcome.link : job.link;
    // 结局的话可能带着接口报错原文：出口前统一过一遍脱敏。
    const said = scrubText(outcome.text, 800);
    if (!outcome.ok) {
      // 「处理中」那张已经换上去了，用户看不到 toast：卡面改回原样、原因回复在卡片下面、放回信封，一起提交。
      // 原因是他自己这一下的结局（scope.ts reply）：任务删了、他看不到了正是常见的原因，不能按卡的来源拦。
      const repair = via === "patch" && !!row.messageId;
      const dest: Destination = { receiveType: row.receiveType as Destination["receiveType"], receiveId: row.receiveId, recipientOpenId: row.recipientOpenId };
      const source = scopeOfRow(row);
      const scope = await replyScope(this.deps.appId, dest, {
        taskId: row.taskId ?? (source?.kind === "task" ? source.taskId : null), projectId: source?.kind === "project" ? source.projectId : null,
      });
      const told = await this.deps.reconciler.exits.admission({ ...row, scope: JSON.stringify(scope) });
      const terse = !told.ok || told.titleOnly;
      const released = await commit(this.deps.reconciler, async (tx) => {
        if (!await releaseEnvelope(tx, claim, said)) return false;
        if (!repair) return true;
        await restoreIn(tx, row.id);
        await this.deps.reconciler.insert({
          dest, taskId: row.taskId, kind: "fail", subject: `fail:${claim.id}:${claim.usedAt}`, msgType: "text",
          content: JSON.stringify({ text: `没办成：${said}` }), replyTo: row.messageId, scope,
          brief: JSON.stringify({ text: "没办成，原因见 ash。" }),
        }, tx);
        return true;
      });
      if (released && repair) this.deps.sender.kick();
      if (via === "patch" && job.taskId) this.deps.reconciler.mark(job.taskId);
      return toast("error", terse ? "没办成，原因见 ash。" : said.slice(0, 60));
    }
    // 卡上、toast 里显示哪一版按出口同一个判据定：没资格的换中性卡，只推标题的用短的那一版。
    const verdict = await this.deps.reconciler.exits.admission(row);
    const tone = outcome.tone ?? "green";
    const full = renderCard(settledCard(header, said, { link }, tone));
    const brief = outcome.brief ? renderCard(settledCard(header, outcome.brief, { link }, tone)) : null;
    const shown = !verdict.ok ? JSON.parse(NEUTRAL_CONTENT(verdict.why)) as Record<string, unknown> : verdict.titleOnly && brief ? brief : full;
    const spare = verdict.ok && !verdict.titleOnly && brief ? JSON.stringify(brief) : null;
    const auditText = outcome.audit && job.taskId ? `经飞书（${click.actorName}）${outcome.audit}` : null;
    const committed = await commit(this.deps.reconciler, async (tx) => {
      if (!await finishEnvelope(tx, claim, said, auditText)) return false;
      const at = now();
      await tx.update(imOutbox).set({
        content: JSON.stringify(shown), brief: spare, updatedAt: at,
        ...(outcome.final ? { state: "resolved", resolution: ACTED, resolvedAt: at } : {}),
        ...(!row.messageId ? {}
          : via === "patch" ? { patchState: "result", nextAt: null }
            : { patchState: "acking", nextAt: new Date(Date.now() + ACK_GRACE_MS).toISOString() }),
      }).where(eq(imOutbox.id, row.id));
      return true;
    });
    if (!committed) return toast("info", REJECT_TEXT.used!);
    if (via === "patch") this.deps.sender.kick();
    // 时间线那一句不挡回执：已经和结局一起记下了，记不上重启后补。
    if (auditText && job.taskId) void audit(job.taskId, claim.id, auditText);
    if (job.taskId) this.deps.reconciler.mark(job.taskId);
    const line = !verdict.ok ? "已处理。" : verdict.titleOnly ? outcome.brief ?? "已处理。" : said;
    return { toast: { type: "success", content: line.slice(0, 60) }, card: { type: "raw", data: shown } };
  }
}

function outcomeOf(result: AshResult, text: string, audit: string, brief?: string): Outcome {
  if (result.ok) return { ok: true, text, final: true, audit, ...(brief ? { brief } : {}) };
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
    return { ok: true, final: true, tone: "red", audit: "点了「验收合并」，验收前置命令没通过", text: "验收前置命令没通过，日志已交回任务修复（详情在 ash 里）。" };
  }
  if (reason === "verify_not_run") return { ok: false, final: false, text: "独立验证还没跑：要不等验证、直接验收，只能在 ash 页面上确认。" };
  return { ok: false, final: false, text: scrubText(result.error, 400) };
}

/**
 * 时间线上留一笔「是从飞书点的」。任务还没有会话（或记不进去）时退回系统提示。真记上了（同一个 eventKey
 * 不会记两次）才清掉待记；两边都没记上就留着，下次启动的 recover() 再补。
 */
async function audit(taskId: string, envelopeId: string, text: string): Promise<void> {
  try {
    const landed = await appendTaskTimeline(taskId, text, { eventKey: `im:${envelopeId}` })
      || await noteSystemNotice(taskId, `im:${envelopeId}`, "飞书操作", text);
    if (landed) await auditDone(envelopeId);
  } catch (error) {
    console.warn(`[ash] 飞书操作记入时间线失败（${taskId}）:`, (error as Error).message);
  }
}
