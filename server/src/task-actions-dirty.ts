// 「这些任务能做什么可能变了」的登记口：库里的触发器（db/task-action-triggers.ts）往这里记，推送
// （task-actions-feed.ts）从这里收。
//
// 单独一个零依赖的小文件：记的一方在 db 层，直接 import 推送那一侧会把半个服务端拖进 db 的依赖、
// 绕出环。
export type TaskActionsDirtyMark =
  | { kind: "task"; taskId: string }
  | { kind: "group"; groupId: string }
  | { kind: "all" };

let sink: ((mark: TaskActionsDirtyMark) => void) | null = null;

export function onTaskActionsDirty(listener: (mark: TaskActionsDirtyMark) => void): void {
  sink = listener;
}

/** 触发器在语句执行当中同步调它：只记账，不碰库。还没人接（推送没起）就什么都不做。 */
export function markTaskActionsDirty(mark: TaskActionsDirtyMark): void {
  sink?.(mark);
}
