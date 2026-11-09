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
// 撤卡只在本进程里、确认收下的那一刻做一次：那一刻写库失败、或者等回执期间服务重启，旧卡就
// 留着，用户答一句即可关掉。曾试过把这件事落库并重试、接管时兑现、开机补扫，每补一档都还剩
// 「两种故障叠在一起」的缝，复杂度远超这张卡的价值，用户 2026-11-09 定为退回到这一版。
//
// 不撤的几种：后端代写的回合（哨兵事件、系统续跑——那不是用户在说话）、旁路回合（验证 / 审查 /
// 原生命令 / 计划模式——它们约定维持原状），以及**归审查的提问**（审查自己的等待由审查链收口，
// 见 task-wait-ownership.ts）。
import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { bus } from "./bus.js";
import type { TaskRow } from "./task-store.js";
import { questionWaitOrigin } from "./task-wait-ownership.js";
import { now } from "./util.js";

type Turn = { system?: boolean; byBackend?: boolean; sideTurn: boolean };

const sameNullable = <T>(column: Parameters<typeof eq>[0], value: T | null) =>
  value === null ? isNull(column) : eq(column, value);

/** 这一轮起跑时挂着、且会被这条真人消息撤下的提问；不撤就是 null。 */
export async function supersedableQuestion(task: TaskRow, turn: Turn): Promise<TaskRow | null> {
  if (!task.question || task.mode !== "single" || turn.system || turn.byBackend || turn.sideTurn) return null;
  const origin = await db.transaction((transaction) => questionWaitOrigin(transaction, task));
  return origin.kind === "ordinary" ? task : null;
}

/**
 * 撤下 `snapshot` 那一次提问。按整组题面 + 占位 + 答复历史比对着写：这中间被答复过、或者 agent
 * 在这一轮里已经重新问了（哪怕题面一字不差，占位也换了），都一个字不动。
 */
export async function supersedeQuestion(snapshot: TaskRow): Promise<void> {
  const updatedAt = now();
  const cleared = await db.transaction(async (transaction) => {
    const current = (await transaction.select().from(tasks).where(eq(tasks.id, snapshot.id)))[0];
    const occupancy = snapshot.waitOwnership?.question?.occupancy;
    if (!current || current.waitOwnership?.question?.occupancy !== occupancy) return false;
    if ((await questionWaitOrigin(transaction, current)).kind !== "ordinary") return false;
    const updated = await transaction.update(tasks)
      .set({ question: null, questionOptions: null, questionItems: null, updatedAt })
      .where(and(
        eq(tasks.id, snapshot.id),
        eq(tasks.question, snapshot.question!),
        sameNullable(tasks.questionOptions, snapshot.questionOptions),
        sameNullable(tasks.questionItems, snapshot.questionItems),
        sameNullable(tasks.questionHistory, snapshot.questionHistory),
      ))
      .returning({ id: tasks.id });
    return updated.length > 0;
  }, { behavior: "immediate" });
  if (cleared) bus.publish({ type: "task.question", taskId: snapshot.id, updatedAt, question: null, questionOptions: null, questionItems: null });
}

const QUOTE_LIMIT = 120;

/** 跟着这一轮提示交给 agent：卡已经撤了，还要等答复就自己重新问。 */
export function questionSupersededNote(question: string): string {
  const quoted = question.length > QUOTE_LIMIT ? `${question.slice(0, QUOTE_LIMIT)}…` : question;
  return `\n\n(ash:你之前的提问「${quoted}」用户没有直接答复，而是发来了上面这条消息，那张问答卡已随之撤下。`
    + `这条消息没回答到它、你仍然需要用户拍板的话，就重新调用 ask_question。)`;
}
