// 「这些任务能做什么可能变了，重算一下」的登记口（推送本体在 task-actions.ts）。
//
// 单独一个零依赖的小文件：要登记的地方（分组暂停、执行器改动）都在依赖图很深的位置，直接 import
// task-actions.ts 会把半个服务端拖进来、绕出环。
export type TaskActionsDirtyMark = { kind: "group"; groupId: string } | { kind: "all" };

let sink: ((mark: TaskActionsDirtyMark) => void) | null = null;

export function onTaskActionsDirty(listener: (mark: TaskActionsDirtyMark) => void): void {
  sink = listener;
}

/** 分组暂停 / 恢复：成员的「重跑上一回合」看分组暂停，「停止」看待启动的队列请求。 */
export function markGroupActionsDirty(groupId: string): void {
  sink?.({ kind: "group", groupId });
}

/** 执行器 profile 被改或删：重跑上一回合的保真前提变了，打开着的任务全部重算。 */
export function markAllTaskActionsDirty(): void {
  sink?.({ kind: "all" });
}
