import type { TaskListItem } from "@ash/shared";

// 主工作区里开着的这一条归档了要不要退出。打开时就已归档的（按停者的链接、地址栏）照常开着 ——
// 「子任务」停着、派活那条又归档了，只有打开它才按得到「接着跑」。只有开着的时候**被**归档了，
// 才退出这条（归档 = 从主工作区收起）。`seen` 记的是这一次打开时它归没归档，换一条 / 重新打开时清空。

export type ArchivedOnOpen = { id: string; archived: boolean } | null;

export function leavesOnArchive(seen: ArchivedOnOpen, task: Pick<TaskListItem, "id" | "archived">,
  inArchiveSettings: boolean): { seen: ArchivedOnOpen; leave: boolean } {
  const opened = seen?.id === task.id ? seen : { id: task.id, archived: !!task.archived };
  return { seen: opened, leave: !!task.archived && !opened.archived && !inArchiveSettings };
}
