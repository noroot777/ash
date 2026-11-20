// 派出去、点叉——用户把框顶的几件了结掉的那一笔（派出去那一下建任务在 dispatch-suggestion-launch.ts，
// 两条路都在自己的事务里调这里的 `resolveWithin`）：
//   · 认领那几件：此刻都还挂着，派出去的那几件跟按下时读到的一样（同批前置没被别处改过），否则整笔不落；
//   · 同一批里还挂着的、要等它们的那几件：前置跟着改——派出去的那件换成它建出来的任务 id（之后再派也接得上
//     它的代码），点叉的那件从前置里划掉（同老派活单「去掉的那几条」）；
//   · 不等的那几件派了、叉了就从这一列拿掉；等着的那一批里的留一个了结记录（`settled`），这一批最后一件了结
//     的那一下就是「处理完」：同一笔里认领那一问（问答记录：用户答的那一句 + 交给智能体的清单）、整批拿掉，
//     continue 还写一条待发送答复（由待发送托盘送进会话——它本来就扛重启、扛「回合被占着」「同队前项还在跑」），
//     done 不写（清单记在问答记录的 `undelivered` 上，下一回合开头补交），换成记下欠的那一下收尾（`settleOwed`）。
// 提交之后（`afterResolved`）只剩「让人看见」和「催一下」，外加当场还一次 done 欠下的收尾（还不上的由
// dispatch-suggestion-settle.ts 开机、每分钟接着还）；每一步各自兜底、互不挡路。
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { DispatchRunTarget } from "@navi/shared/dispatch-target";
import type { DispatchOrder, DispatchWait, StoredSuggestion } from "@navi/shared/dispatch-suggestion";
import type { QuestionRecord } from "@navi/shared/questions";
import { db } from "./db/index.js";
import { scheduledMessages, tasks } from "./db/schema.js";
import { bus } from "./bus.js";
import { readSuggestions, rewritePrerequisites, scopedKey, serializedSuggestions, waitingBatchOf } from "./dispatch-suggestion.js";
import { launchBubble, launchReply, type TargetLabel } from "./dispatch-suggestion-wait.js";
import { launchDebtFor, settleLaunchDebt } from "./dispatch-suggestion-settle.js";
import { deliverPendingMessages, pendingMessageRow, publishPendingMessages } from "./pending-messages.js";
import { answerRouteFor } from "./task-answer.js";
import { claimQuestionAnswerWithin } from "./task-question-record.js";
import { publishTaskUpdated, type TaskRow } from "./task-store.js";
import { now } from "./util.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 那几件已经不在了（派出去、叉掉、被收回），或者跟按下时看到的不一样了。 */
export class SuggestionClaimLost extends Error {
  constructor(readonly missing: string[], message = "这几件已经派出去、叉掉或被智能体收回了，请看最新的那几行") { super(message); }
}
/** 这一下不能做（等着的那一批那一回合还没停、同批前置会落空）：409，原样说给用户。 */
export class SuggestionConflict extends Error {}

export type Delivery = Awaited<ReturnType<typeof answerRouteFor>>;

/** 事务之前备好的：交给谁怎么读、那一行的初始交给谁、碰到等着的那一批时答复送给谁。 */
export type ResolveContext = {
  label: TargetLabel;
  proposed: (item: StoredSuggestion) => DispatchRunTarget | null;
  /** 这一下派出去用的排法（点叉的那一下没有，取那一批自己的）。 */
  order?: DispatchOrder;
  delivery: Delivery | null;
  owner: string | null;
};

export type Resolved = {
  /** 等着的那一批这一下处理完了：问答记录、它说定的那一档。 */
  closed: { record: QuestionRecord; wait: Exclude<DispatchWait, "none"> } | null;
};

const busy = (status: string) => status === "running" || status === "queued";

/** 按下时读到的这一列里，这几件碰没碰到等着的那一批；碰到了就先核能不能做、备好答复送给谁（在事务之前）。 */
export async function prepareResolve(task: TaskRow, ids: readonly string[]): Promise<{ delivery: Delivery | null } | { error: string }> {
  const waiting = new Set(waitingBatchOf(readSuggestions(task)).map((item) => item.id));
  if (!ids.some((suggestion) => waiting.has(suggestion))) return { delivery: null };
  if (busy(task.status)) return { error: "这一批是摆单那一轮在等你过目的，那一轮还没结束，等它停下再处理" };
  const delivery = await answerRouteFor(task);
  if (delivery.origin.kind !== "ordinary") return { error: "这一批不是在普通回合里摆的，处理不了，请刷新后再看" };
  return { delivery };
}

/**
 * 认领、改前置、了结，必要时处理完那一批。`launch` 是派出去的那几件（建出来的任务号、标题、交给谁），
 * `drop` 是点叉的那几件；`expect` 是按下时读到的那几件的前置（建任务的前置边照它算，变了就整笔不落）。
 */
export async function resolveWithin(
  transaction: Transaction,
  taskId: string,
  change: {
    launch: { id: string; task: { id: string; title: string; target: DispatchRunTarget } }[];
    drop: string[];
    expect?: Map<string, string[] | undefined>;
  },
  context: ResolveContext,
): Promise<Resolved> {
  const row = (await transaction.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row) throw new SuggestionClaimLost([...change.launch.map((item) => item.id), ...change.drop]);
  const items = readSuggestions(row);
  const hanging = new Map(items.filter((item) => !item.settled).map((item) => [item.id, item]));
  const targeted = [...change.launch.map((item) => item.id), ...change.drop];
  const missing = targeted.filter((suggestion) => !hanging.has(suggestion));
  if (missing.length) throw new SuggestionClaimLost(missing);
  for (const [suggestion, prerequisites] of change.expect ?? []) {
    if (JSON.stringify(hanging.get(suggestion)!.prerequisites ?? []) !== JSON.stringify(prerequisites ?? [])) {
      throw new SuggestionClaimLost([suggestion], "这一件要等的那几件刚被别处派出去或叉掉了，请看最新的那几行再派");
    }
  }
  const touchesWaiting = targeted.some((suggestion) => hanging.get(suggestion)!.wait !== "none");
  if (touchesWaiting && busy(row.status)) throw new SuggestionConflict("这一批是摆单那一轮在等你过目的，那一轮还没结束，等它停下再处理");
  if (touchesWaiting && !context.delivery) throw new SuggestionClaimLost(targeted, "这几件刚变成在等你过目的那一批，请刷新后再看");

  const at = now();
  const launched = new Map(change.launch.map((item) => [item.id, item.task]));
  const dropped = new Set(change.drop);
  // 同一批里被了结的那几件的 key：派出去的换成任务 id，点叉的划掉。
  const rewrite = new Map<string, string | null>();
  for (const suggestion of targeted) {
    const item = hanging.get(suggestion)!;
    if (item.key) rewrite.set(scopedKey(item, item.key), launched.get(suggestion)?.id ?? null);
  }
  const next = rewritePrerequisites(items.flatMap((item): StoredSuggestion[] => {
    if (!launched.has(item.id) && !dropped.has(item.id)) return [item];
    return item.wait === "none" ? [] : [{ ...item, settled: { at, task: launched.get(item.id) ?? null } }];
  }), rewrite);

  const batch = waitingBatchOf(next);
  if (!touchesWaiting || batch.some((item) => !item.settled)) {
    await transaction.update(tasks).set({ dispatchSuggestions: serializedSuggestions(next), dispatchPlan: null, updatedAt: at })
      .where(eq(tasks.id, taskId));
    return { closed: null };
  }

  // —— 等着的那一批最后一件了结了：处理完。
  const wait = batch[0]!.wait as Exclude<DispatchWait, "none">;
  const settled = batch.map((item) => ({ ...item, settled: item.settled! }));
  const order = context.order ?? batch[0]!.order;
  const settleDone = wait === "done";
  const built = settled.flatMap((item) => (item.settled.task ? [item.settled.task] : []));
  const record: QuestionRecord = {
    question: row.question, questionOptions: null, questionItems: null, id: nanoid(12), answeredAt: at,
    answer: launchBubble(settled, order, context.proposed, context.label),
    reply: launchReply(settled, order, context.label, settleDone),
    // 会话里认这一下只认它（shared dispatch-suggestion.ts `dispatchLaunchOf`），不看答复正文。
    ...(built.length ? { dispatchLaunch: built.map((task) => ({ id: task.id, title: task.title, agent: context.label(task.target) })) } : {}),
    ...(settleDone ? { undelivered: true as const, settleOwed: launchDebtFor(row) } : {}),
  };
  const remaining = next.filter((item) => item.wait === "none");
  if (!await claimQuestionAnswerWithin(transaction, row, record, undefined, remaining)) {
    throw new SuggestionClaimLost(targeted, "那一问刚被答掉或撤下了，请刷新后再看");
  }
  if (!settleDone) {
    const delivery = context.delivery!;
    await transaction.insert(scheduledMessages).values(pendingMessageRow({
      taskId, text: record.reply, ...delivery.route, ownerUserId: context.owner, answerId: record.id, execution: !delivery.sideways,
    }));
  }
  return { closed: { record, wait } };
}

/** 提交之后：让人看见（框顶、问答记录），done 还一次欠下的收尾，continue 催一下待发送答复。各自兜底，都不改变「已经了结」。 */
export function afterResolved(taskId: string, resolved: Resolved, what: string): void {
  const settle = (step: string, work: () => unknown) => {
    void Promise.resolve().then(work).catch((error) => console.error(`[navi] ${what}之后${step}出错 ${taskId}:`, error));
  };
  const closed = resolved.closed;
  if (closed) {
    settle("广播收卡", () => bus.publish({
      type: "task.question", taskId, updatedAt: closed.record.answeredAt,
      question: null, questionOptions: null, questionItems: null, answeredQuestion: closed.record,
    }));
  }
  settle("广播框顶", () => publishTaskUpdated(taskId));
  if (!closed) return;
  if (closed.wait === "done") settle("收尾", () => settleLaunchDebt(taskId));
  else settle("送答复", () => { publishPendingMessages(taskId); return deliverPendingMessages(taskId); });
}
