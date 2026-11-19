import type { TaskListItem } from "@navi/shared";

/**
 * 会话里靠右那一句小灰字「开了新任务〈标题〉，交给 codex」：你在回复框里派出去的每一条各一句。
 *
 * 不另存一份记录，直接从任务列表里认——派出去的任务带着 dispatchedBy（挂在谁名下）和创建来源
 * （用户自己建的）。刷新以后照样在，标题跟着新任务自动起的名字走；智能体在回合里派的不算（那件事
 * 在它的执行过程里已经看得见）。
 */
export type DispatchNote = { id: string; at: string; title: string; agent: string | null };

export function dispatchNotes(taskId: string, tasks: readonly TaskListItem[]): DispatchNote[] {
  return tasks
    .filter((task) => task.dispatchedBy === taskId && task.creationOrigin?.kind === "user")
    .map((task) => ({ id: task.id, at: task.createdAt, title: task.title || "未命名任务", agent: task.agentType ?? null }))
    .sort((left, right) => left.at.localeCompare(right.at));
}
