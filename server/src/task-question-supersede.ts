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
// 幂等出口 `supersedeQuestion`；没确认送达的那几轮留下的记录换了令牌就不再作数。
//
// 不撤的几种：后端代写的回合（哨兵事件、系统续跑——那不是用户在说话）、旁路回合（验证 / 审查 /
// 原生命令 / 计划模式——它们约定维持原状），以及**归审查的提问**（审查自己的等待由审查链收口，
// 见 task-wait-ownership.ts）。
import { and, eq, isNull } from "drizzle-orm";
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
    if (!current || armed?.turnToken !== turnToken) return false;
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

/** 重启接管回来的那一轮：它的输入回执落定成「收下了」就按库里的记录兑现（没回执能力的按收下算）。 */
export async function settleAdoptedQuestionSupersede(taskId: string, turnToken: string | null,
  receipt: Promise<InputAcceptance> | undefined): Promise<void> {
  if (!turnToken) return;
  if (await (receipt ?? Promise.resolve<InputAcceptance>("accepted")) === "accepted") await supersedeQuestion(taskId, turnToken);
}

const QUOTE_LIMIT = 120;

/** 跟着这一轮提示交给 agent：卡已经撤了，还要等答复就自己重新问。 */
export function questionSupersededNote(question: string): string {
  const quoted = question.length > QUOTE_LIMIT ? `${question.slice(0, QUOTE_LIMIT)}…` : question;
  return `\n\n(ash:你之前的提问「${quoted}」用户没有直接答复，而是发来了上面这条消息，那张问答卡已随之撤下。`
    + `这条消息没回答到它、你仍然需要用户拍板的话，就重新调用 ask_question。)`;
}
