// 「等某任务完成后发送」的候选与托盘口径。回复框(普通任务 / 团队调度台)选目标、托盘
// 显示「在等谁」都读这里,判据与服务端 pending-after.ts 同源:只有「完成」算数。
import type { Group, TaskListItem, TaskStatus } from "@ash/shared";
import { TASK_STATUS_LABELS } from "@ash/shared";
import type { DropdownOption } from "../components/Dropdown.tsx";

const FINISHED: readonly TaskStatus[] = ["done", "failed", "canceled"];

/** 同项目、未归档、不是自己的任务都列出来;已完成的置灰(没什么可等的,直接发就是)。
 * 还会完成的排上面,失败/取消的放后面(重跑完成后才会发),置灰的沉底。团队调度台不列:
 * 它收工落「待命」,没有「完成」这一步,等它永远等不到(服务端写入口同样拒收)。 */
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
    .filter((task) => task.projectId === projectId && !task.archived && task.id !== taskId && task.mode !== "team")
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

/** 托盘里那一行「在等谁、还等得到吗」。stuck = 它不会自己完成了,要用户拿主意。
 * `doneAt` 是服务端锁存的完成时刻:记下了就是等到了,之后前置任务再跑、失败或被删都不改口。
 * 没锁存时只认实际 status=done —— 已完成任务又在处理新消息时显示「运行中」,服务端也判没完成。 */
export function sendAfterState(
  task: Pick<TaskListItem, "title" | "status" | "archived"> & Partial<Pick<TaskListItem, "mode">> | undefined,
  doneAt: string | null = null,
): {
  label: string;
  stuck: boolean;
} {
  const name = `「${task?.title || "前置任务"}」`;
  if (doneAt) return { label: `${name}已完成`, stuck: false };
  if (!task) return { label: "前置任务已删除", stuck: true };
  // 升级前或接力过来的存量行:调度台收工落「待命」,永远等不到,得让用户拿主意。
  if (task.mode === "team") return { label: `${name}是团队调度台，等不到完成`, stuck: true };
  if (task.status === "done") return { label: `${name}已完成`, stuck: false };
  if (task.archived) return { label: `${name}已归档`, stuck: true };
  if (task.status === "failed" || task.status === "canceled") {
    return { label: `${name}${TASK_STATUS_LABELS[task.status]}`, stuck: true };
  }
  return { label: `等${name}完成`, stuck: false };
}
