// 「等某任务完成后发送」的候选与托盘口径。回复框(普通任务 / 团队调度台)选目标、托盘
// 显示「在等谁」都读这里,判据与服务端 pending-after.ts 同源:只有「完成」算数。
import type { Group, TaskListItem, TaskStatus } from "@ash/shared";
import { TASK_STATUS_LABELS } from "@ash/shared";
import type { DropdownOption } from "../components/Dropdown.tsx";

const FINISHED: readonly TaskStatus[] = ["done", "failed", "canceled"];

/** 同项目、未归档、不是自己的任务都列出来;已完成的置灰(没什么可等的,直接发就是)。
 * 还会完成的排上面,失败/取消的放后面(重跑完成后才会发),置灰的沉底。 */
export function sendAfterOptions({ tasks, groups, projectId, taskId }: {
  tasks: TaskListItem[];
  groups: Group[];
  projectId: string;
  taskId: string;
}): DropdownOption[] {
  const groupName = (groupId: string | null) =>
    groupId == null ? "无分组" : groups.find((group) => group.id === groupId)?.name ?? "未知分组";
  const rank = (task: TaskListItem) => task.status === "done" ? 2 : FINISHED.includes(task.status) ? 1 : 0;
  return tasks
    .filter((task) => task.projectId === projectId && !task.archived && task.id !== taskId)
    .map((task, index) => ({ task, index }))
    .sort((a, b) => rank(a.task) - rank(b.task) || a.index - b.index)
    .map(({ task }) => ({
      value: task.id,
      label: task.title || "未命名任务",
      group: groupName(task.groupId),
      detail: task.status === "done"
        ? "已完成 · 直接发送即可"
        : FINISHED.includes(task.status)
          ? `${TASK_STATUS_LABELS[task.status]} · 重跑完成后才发`
          : TASK_STATUS_LABELS[task.status],
      disabled: task.status === "done",
    }));
}

/** 托盘里那一行「在等谁、还等得到吗」。stuck = 它不会自己完成了,要用户拿主意。 */
export function sendAfterState(task: Pick<TaskListItem, "title" | "status" | "archived"> | undefined): {
  label: string;
  stuck: boolean;
} {
  if (!task) return { label: "前置任务已删除", stuck: true };
  const name = `「${task.title || "未命名任务"}」`;
  if (task.status === "done") return { label: `${name}已完成`, stuck: false };
  if (task.archived) return { label: `${name}已归档`, stuck: true };
  if (task.status === "failed" || task.status === "canceled") {
    return { label: `${name}${TASK_STATUS_LABELS[task.status]}`, stuck: true };
  }
  return { label: `等${name}完成`, stuck: false };
}
