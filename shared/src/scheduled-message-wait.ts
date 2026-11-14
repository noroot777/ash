// 一条待发送消息此刻在等什么。服务端拿投递判定用的同一份事实算出来（server/src/pending-wait.ts），
// 随 `GET /tasks/:id/scheduled-messages` 下发；托盘只照着说，不按任务状态或消息 mode 自己猜。
//
// 从前托盘按 mode 写死「等待当前一轮结束」：任务早就停了、真正挡着它的是同队另一条任务时，
// 那句话让人以为页面卡死了（2026-11-13 现场：终态任务上的答复被同队在跑的成员挡着）。

/** 同队挡路的那一条：标题 + 它是在跑，还是排在前面没完成（排序与选取见 server/src/queues.ts）。 */
export type QueueBlocker = { id: string; title: string; running: boolean };

export type ScheduledMessageWait =
  /** 本任务这一轮还没结束。 */
  | { kind: "turn" }
  /** 同一队列里有别的成员在跑或排在前面没完成；在跑的排前。 */
  | { kind: "queue"; blockers: QueueBlocker[] }
  /** 所在分组被暂停了，恢复之前不会发。 */
  | { kind: "groupPaused" }
  /** 定时消息没到点、等的前置任务没完成：托盘按钟点 / 前置任务另外说。 */
  | { kind: "schedule" }
  /** 已经在送了（投递租约挂着）。 */
  | { kind: "delivering" };

/** 「挡路的是谁」那半句。被挡回时的完整话术（`queueBlockedText`）和托盘的等待说明共用它。 */
export function queueBlockerPhrase(blockers: readonly QueueBlocker[]): string {
  const [first] = blockers;
  if (!first) return "同一队列里还有未完成或正在运行的任务";
  if (blockers.length > 1) return `同一队列里「${first.title}」等 ${blockers.length} 条任务还没完成或正在运行`;
  return first.running ? `同一队列里「${first.title}」正在运行` : `同一队列里排在前面的「${first.title}」还没完成`;
}

// 被队列挡回时回给用户的那一句,/run、/fire、认领占位、重试这一回合共用。挡路的可能排在
// 后面(manualStartBlockers 的第 ① 类),所以不说「队列前面」;说出是哪一条,用户才知道去
// 等谁、处理谁。
export function queueBlockedText(blockers: readonly QueueBlocker[]): string {
  const [first] = blockers;
  const way = !first || blockers.length > 1 ? "先等它们结束、处理完"
    : first.running ? "先等它结束" : "先等它结束、处理完";
  return `${queueBlockerPhrase(blockers)}，${way}，或把本任务移出队列`;
}

/** 托盘上那一句。null = 没有可说的（按钟点/前置任务的另有说法，或者此刻没有挡着它的东西）。 */
export function scheduledWaitText(wait: ScheduledMessageWait | null | undefined): string | null {
  switch (wait?.kind) {
    case "turn": return "等本任务这一轮结束";
    case "queue": return `${queueBlockerPhrase(wait.blockers)}，轮到本任务时发送`;
    case "groupPaused": return "分组已暂停，恢复后发送";
    case "delivering": return "正在发送";
    default: return null;
  }
}
