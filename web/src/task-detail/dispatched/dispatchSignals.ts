import type { DispatchSignal, TaskListItem } from "@ash/shared";

// 派它的那条任务的会话里，派出的任务失败的那几刻怎么画（判据单独成文件，回归测试直接钉这一份；
// 组件只管画）。
//
// 记录是服务端那一份（GET /tasks/:id/dispatch-signals，刷新后照样在），标题、执行器读任务列表里
// 那条任务现在的样子（随 SSE 实时合并）。
//
// 派出的任务来问不画在这里：答题卡只在提问的那条任务自己的页面上，派它的这一条只靠侧栏、任务头
// 那颗「派出的任务」键的数变色和右侧那一格里的那一行知道（lib/dispatchTree.ts 的 dispatchNeedsYou）。

export type DispatchBubble = {
  key: string;
  at: string;
  taskId: string;
  title: string;
  executor: string | null;
  /** 失败原因的头一句。 */
  text: string;
};

const UNTITLED = "未命名任务";
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

const taskTitle = (task: Pick<TaskListItem, "title"> | undefined) => task ? task.title || UNTITLED : FALLBACK_TITLE;

/**
 * 两条记录谁先发生：先比那一刻，同一刻（同一毫秒一起来）再比序号（shared 那份类型的说明）。
 */
const signalOrder = (a: DispatchSignal, b: DispatchSignal) => a.at.localeCompare(b.at) || a.seq - b.seq;

/** 失败没说出原因时的那一句（同会话里老记录的说法）。 */
const NO_REASON = "这一轮异常结束";

export function dispatchBubbles(signals: readonly DispatchSignal[], tasks: readonly TaskListItem[]): DispatchBubble[] {
  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  return [...signals].sort(signalOrder).map((signal) => {
    const task = byId.get(signal.taskId);
    return {
      key: `dispatch:${signal.seq}`, at: signal.at, taskId: signal.taskId,
      title: taskTitle(task), executor: task?.executorLabel || task?.agentType || null,
      text: headSentence(signal.reason) || NO_REASON,
    };
  });
}

/** 名下派出的任务此刻的样子里，会让那份记录变的那一样（失败了、重试了：变了就去重读一次）。 */
export function dispatchedSignature(dispatched: readonly TaskListItem[]): string {
  return dispatched.map((task) => `${task.id}:${task.status}`).join("|");
}
