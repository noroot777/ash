import type { DispatchSignal, TaskListItem } from "@ash/shared";
import type { QuestionRecord } from "@ash/shared/questions";

// 派它的那条任务的会话里，派出的任务那几刻怎么画、回复框那一格轮到谁答（判据单独成文件，回归测试
// 直接钉这一份；组件只管画）。
//
// 记录是服务端那一份（GET /tasks/:id/dispatch-signals，刷新后照样在），「此刻怎样」读任务列表里
// 那条任务现在的样子（随 SSE 实时合并）——气泡写的是那一刻的事，状态词说它现在还等不等。

export type DispatchBubbleState = "waiting" | "answered" | "closed" | "failed";

export type DispatchBubble = {
  key: string;
  at: string;
  taskId: string;
  title: string;
  executor: string | null;
  /** 题目 / 失败原因的头一句。 */
  text: string;
  state: DispatchBubbleState;
};

/** 在这里答的那一题：「你」那颗气泡 + 下面一句小灰字。 */
export type DispatchAnswer = { key: string; at: string; taskId: string; title: string; record: QuestionRecord };

export const UNTITLED = "未命名任务";
const FALLBACK_TITLE = "派出的任务";
const HEAD_MAX = 120;

/** 头一句：去掉 markdown 记号、并成一行，截到第一个句末（或换行）。 */
export function headSentence(text: string | null | undefined): string {
  const flat = (text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\n\s*\n/)[0]!
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const end = flat.search(/[。！？!?]|[.;；](\s|$)/);
  const head = end >= 0 ? flat.slice(0, end + 1) : flat;
  return head.length > HEAD_MAX ? `${head.slice(0, HEAD_MAX - 1)}…` : head;
}

export const taskTitle = (task: Pick<TaskListItem, "title"> | undefined) => task ? task.title || UNTITLED : FALLBACK_TITLE;

/** 每条任务最近那一问（只有它可能还在等）。 */
function latestQuestions(signals: readonly DispatchSignal[]): Map<string, DispatchSignal> {
  const latest = new Map<string, DispatchSignal>();
  for (const signal of signals) if (signal.kind === "question") latest.set(signal.taskId, signal);
  return latest;
}

/** 失败没说出原因时的那一句（同会话里老记录的说法）。 */
const NO_REASON = "这一轮异常结束";

export function dispatchFeed(signals: readonly DispatchSignal[], tasks: readonly TaskListItem[]): {
  bubbles: DispatchBubble[];
  answers: DispatchAnswer[];
} {
  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  const latest = latestQuestions(signals);
  const bubbles: DispatchBubble[] = [];
  const answers: DispatchAnswer[] = [];
  for (const signal of signals) {
    const task = byId.get(signal.taskId);
    const base = {
      key: `dispatch:${signal.seq}`, at: signal.at, taskId: signal.taskId,
      title: taskTitle(task), executor: task?.executorLabel || task?.agentType || null,
    };
    if (signal.kind === "failed") {
      bubbles.push({ ...base, text: headSentence(signal.reason) || NO_REASON, state: "failed" });
      continue;
    }
    const waiting = latest.get(signal.taskId) === signal && !!task?.question;
    bubbles.push({
      ...base,
      text: headSentence(signal.question),
      state: waiting ? "waiting" : signal.answered ? "answered" : "closed",
    });
    if (signal.answer) {
      answers.push({ key: `dispatch-answer:${signal.seq}`, at: signal.answer.answeredAt, taskId: signal.taskId, title: base.title, record: signal.answer });
    }
  }
  return { bubbles, answers };
}

/**
 * 回复框那一格此刻轮到谁：这条任务自己在问就先答它自己的；否则名下派出的任务里在问的那几条，
 * 按提问先后一次一张：两条都有记录就按记录的序号（同一毫秒里一起来是常态，时刻分不出先后）；
 * 记录还没读到的那条按任务最后改动的时刻比，再分不出按派出的先后。
 * 只看直接派出的那一层：再往下一层的提问冒在它自己的上一层。
 */
export function askingOrder(host: TaskListItem, dispatched: readonly TaskListItem[], signals: readonly DispatchSignal[]): TaskListItem[] {
  const latest = latestQuestions(signals);
  const askedAt = (task: TaskListItem) => latest.get(task.id)?.at ?? task.updatedAt;
  const bySeq = (a: TaskListItem, b: TaskListItem) => {
    const left = latest.get(a.id)?.seq;
    const right = latest.get(b.id)?.seq;
    return left !== undefined && right !== undefined ? left - right : null;
  };
  const children = dispatched
    .filter((task) => task.id !== host.id && !!task.question && !task.archived)
    .sort((a, b) => bySeq(a, b) ?? (askedAt(a).localeCompare(askedAt(b)) || a.createdAt.localeCompare(b.createdAt)));
  return host.question ? [host, ...children] : children;
}

/** 名下派出的任务此刻的样子里，会让那份记录变的那几样（变了就去重读一次）。 */
export function dispatchedSignature(dispatched: readonly TaskListItem[]): string {
  return dispatched.map((task) => `${task.id}:${task.status}:${task.question ?? ""}`).join("|");
}
