// 用户没答提问、直接发来一条新消息时，那道提问怎么办。
//
// 提问是「上一个方向」留下的等待：ask_question 只认当时那一轮的方向身份（task-question.ts），
// 运行中引导换方向时也会把它清掉（task-steer-direction-state.ts「换方向就是换方向」）。新起一轮
// 的真人消息是同一件事，只是这一侧原先没清 —— 于是那张卡跨过用户后来的每一条消息一直挂着：
// 新一轮在跑时被前端读成「正在结束提问」、答复按钮灰着；这一轮结束后又以「续聊回合以提问结束」
// 原样复活，哪怕用户这条消息已经说了「那件事不用管了」。agent 手里没有撤回提问的工具，只剩
// 用户去「答」一道已经作废的题才能把卡关掉。
//
// 所以：真人消息**确认送到 agent 手里之后**撤下上一轮那道提问 —— 认的是执行器的输入回执
// (turn-input-settlement.ts `whenAccepted`)，不是本地会话落盘：拒收、结果不明都留着那道题，
// 迟到确认收下了再撤。这一轮的提示里同时告诉 agent 卡已撤，仍需拍板就重新问 —— 要不要继续
// 等，只有读过这条消息的 agent 判断得了。
//
// 「这一轮输入收下后要撤哪一问」**起跑前就落库**（`waitOwnership.questionSupersede`，绑这一轮的
// 回合令牌），不只活在本进程的回调里：等回执的那几十秒里服务重启，接管回来的那一轮照样确认
// 送达，那时由接管入口（reattach.ts）按库里这份记录兑现。当场确认、迟到确认、接管确认走同一个
// 出口 `honorQuestionSupersede`；没确认送达的那几轮留下的记录换了令牌就不再作数。
//
// **兑现失败不许丢责任**：确认收下的那一刻先把「已收下」落进记录，再撤卡；任何一步写库失败都
// 在本进程里退避重试，直到撤掉、或者确认那一问已被答复 / 重问（同样了结记录）。进程这期间没了，
// 开机扫一遍带着「已收下」的记录补做（`sweepQuestionSupersedes`，index.ts 启动段）。登记本身
// 写不进库就不起跑这一轮 —— 「消息发出去了、撤卡的事却没人记着」这一档不许存在。
//
// 不撤的几种：后端代写的回合（哨兵事件、系统续跑——那不是用户在说话）、旁路回合（验证 / 审查 /
// 原生命令 / 计划模式——它们约定维持原状），以及**归审查的提问**（审查自己的等待由审查链收口，
// 见 task-wait-ownership.ts）。
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { bus } from "./bus.js";
import type { InputAcceptance } from "./executors/types.js";
import type { TaskRow } from "./task-store.js";
import { questionWaitOrigin } from "./task-wait-ownership.js";
import { now } from "./util.js";

type Turn = { system?: boolean; byBackend?: boolean; sideTurn: boolean };

const sameNullable = <T>(column: Parameters<typeof eq>[0], value: T | null) =>
  value === null ? isNull(column) : eq(column, value);

/**
 * 这一轮是真人消息、起跑时又挂着一道普通提问：把「收下后撤它」记进库里，返回题面（拼进提示用）；
 * 不撤就是 null。要在 spawn 之前调 —— 记录落库之后输入才可能被收下。
 */
export async function armQuestionSupersede(task: TaskRow, turnToken: string, turn: Turn): Promise<string | null> {
  if (!task.question || task.mode !== "single" || turn.system || turn.byBackend || turn.sideTurn) return null;
  return db.transaction(async (transaction) => {
    const current = (await transaction.select().from(tasks).where(eq(tasks.id, task.id)))[0];
    if (!current?.question || (await questionWaitOrigin(transaction, current)).kind !== "ordinary") return null;
    await transaction.update(tasks).set({ waitOwnership: { ...current.waitOwnership, questionSupersede: {
      turnToken, text: current.question, options: current.questionOptions, items: current.questionItems,
      history: current.questionHistory, occupancy: current.waitOwnership?.question?.occupancy ?? null,
    } } }).where(eq(tasks.id, task.id));
    return current.question;
  }, { behavior: "immediate" });
}

/**
 * `turnToken` 那一轮的输入确认收下了：按它起跑时记下的那一问撤卡，并了结这份记录（幂等）。按整组
 * 题面 + 占位 + 答复历史比对：这中间被答复过、或者 agent 在这一轮里已经重新问了（哪怕题面一字
 * 不差，占位也换了），都一个字不动。
 */
export async function supersedeQuestion(taskId: string, turnToken: string): Promise<void> {
  const updatedAt = now();
  const cleared = await db.transaction(async (transaction) => {
    const current = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    const armed = current?.waitOwnership?.questionSupersede;
    if (!current || armed?.turnToken !== turnToken || !armed.accepted) return false;
    const { questionSupersede: _done, ...ownership } = current.waitOwnership!;
    await transaction.update(tasks).set({ waitOwnership: ownership }).where(eq(tasks.id, taskId));
    if ((current.waitOwnership?.question?.occupancy ?? null) !== armed.occupancy) return false;
    if ((await questionWaitOrigin(transaction, current)).kind !== "ordinary") return false;
    const updated = await transaction.update(tasks)
      .set({ question: null, questionOptions: null, questionItems: null, updatedAt })
      .where(and(
        eq(tasks.id, taskId),
        eq(tasks.question, armed.text),
        sameNullable(tasks.questionOptions, armed.options),
        sameNullable(tasks.questionItems, armed.items),
        sameNullable(tasks.questionHistory, armed.history),
      ))
      .returning({ id: tasks.id });
    return updated.length > 0;
  }, { behavior: "immediate" });
  if (cleared) bus.publish({ type: "task.question", taskId, updatedAt, question: null, questionOptions: null, questionItems: null });
}

/** `turnToken` 那一轮的输入记成「已收下」（撤卡失败、进程又没了时，开机补做认的就是这一笔）。 */
async function markAccepted(taskId: string, turnToken: string): Promise<void> {
  await db.transaction(async (transaction) => {
    const current = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    const armed = current?.waitOwnership?.questionSupersede;
    if (!current || armed?.turnToken !== turnToken || armed.accepted) return;
    await transaction.update(tasks).set({ waitOwnership: { ...current.waitOwnership, questionSupersede: { ...armed, accepted: true } } })
      .where(eq(tasks.id, taskId));
  }, { behavior: "immediate" });
}

/** 写库失败后的退避（毫秒）；用完了就按最后一档一直重试，直到成功或记录被了结。 */
const RETRY_MS = [1_000, 5_000, 30_000, 120_000];

/**
 * 输入确认收下了：记「已收下」→ 撤卡。不抛：失败只会推迟，不会丢 —— 本进程里退避重试，进程没了
 * 由开机扫描接手。重复调用无害（记录了结之后两步都是空转）。
 */
export async function honorQuestionSupersede(taskId: string, turnToken: string, attempt = 0): Promise<void> {
  try {
    await markAccepted(taskId, turnToken);
    await supersedeQuestion(taskId, turnToken);
  } catch (error) {
    const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!;
    console.error(`[ash] 任务 ${taskId} 撤下旧提问失败，${wait / 1000} 秒后重试:`, error);
    setTimeout(() => void honorQuestionSupersede(taskId, turnToken, attempt + 1), wait).unref?.();
  }
}

/** 重启接管回来的那一轮：它的输入回执落定成「收下了」就兑现（没回执能力的按收下算）。 */
export async function settleAdoptedQuestionSupersede(taskId: string, turnToken: string | null,
  receipt: Promise<InputAcceptance> | undefined): Promise<void> {
  if (!turnToken) return;
  const fact = await (receipt ?? Promise.resolve<InputAcceptance>("accepted")).catch((): InputAcceptance => "unknown");
  if (fact === "accepted") await honorQuestionSupersede(taskId, turnToken);
}

/** 开机补做：上一个进程确认收下了、却没来得及撤卡的那几笔。 */
export async function sweepQuestionSupersedes(): Promise<number> {
  const rows = await db.select({ id: tasks.id, waitOwnership: tasks.waitOwnership }).from(tasks)
    .where(sql`json_extract(${tasks.waitOwnership}, '$.questionSupersede.accepted') = 1`);
  for (const row of rows) await honorQuestionSupersede(row.id, row.waitOwnership!.questionSupersede!.turnToken);
  return rows.length;
}

const QUOTE_LIMIT = 120;

/** 跟着这一轮提示交给 agent：卡已经撤了，还要等答复就自己重新问。 */
export function questionSupersededNote(question: string): string {
  const quoted = question.length > QUOTE_LIMIT ? `${question.slice(0, QUOTE_LIMIT)}…` : question;
  return `\n\n(ash:你之前的提问「${quoted}」用户没有直接答复，而是发来了上面这条消息，那张问答卡已随之撤下。`
    + `这条消息没回答到它、你仍然需要用户拍板的话，就重新调用 ask_question。)`;
}
