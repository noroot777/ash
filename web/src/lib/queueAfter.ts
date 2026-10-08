// 「排在某任务之后」的共享逻辑:候选列表构造 + 落库动作。
// 两个入口共用 —— 任务详情检查器(存量任务入队,分组已定)和新建任务面板
// (launchMode="queue",新任务的分组随目标任务)。
// 候选按用户拍板「全部列出不过滤」:不合法的置灰并在右侧灰字写明原因。
// 落库语义:目标已在队列 → 紧随其后插入;不在 → 建一条 [目标, 本任务] 的新队列。
// 推进由服务端 advanceQueue 负责:前驱全是终态时新成员会立刻被拉起。
import type { Group, TaskListItem, TaskStatus } from "@ash/shared";
import { TASK_STATUS_LABELS } from "@ash/shared";
import type { DropdownOption } from "../components/Dropdown.tsx";
import { api } from "./api.ts";

const TERMINAL: readonly TaskStatus[] = ["done", "failed", "canceled"];

/** 这个任务现在还能不能谈「排队等前面跑完」:只对还没开始跑的任务有意义。 */
export function canJoinQueue(task: Pick<TaskListItem, "status" | "parentId" | "archived" | "queueId">): boolean {
  return task.parentId === null
    && !task.archived
    && task.queueId == null
    && (task.status === "backlog" || task.status === "paused");
}

export function queueAfterOptions({ tasks, groups, projectId, excludeId, subjectGroupId }: {
  tasks: TaskListItem[];
  groups: Group[];
  projectId: string;
  /** 正在排队的任务自己(新建面板还没有 id,不传)。 */
  excludeId?: string;
  /**
   * 排队主体的分组已经定死时传入(检查器入口):别组候选照列但置灰。
   * 新建面板不传 —— 新任务的分组随选中的目标走,任何组都可选。
   */
  subjectGroupId?: string | null;
}): DropdownOption[] {
  const groupName = (groupId: string | null) =>
    groupId == null ? "无分组" : groups.find((group) => group.id === groupId)?.name ?? "未知分组";
  const queueSize = (queueId: string) => tasks.filter((task) => task.queueId === queueId).length;
  const lockedGroup = subjectGroupId !== undefined;
  const candidates = tasks.filter((task) =>
    task.projectId === projectId && task.parentId === null && !task.archived && task.id !== excludeId);
  // 同组的排前面(分组锁定时它们才是真正可选的);组内保持列表原序。
  const sorted = lockedGroup
    ? [...candidates].sort((a, b) =>
      Number((a.groupId ?? null) !== (subjectGroupId ?? null)) - Number((b.groupId ?? null) !== (subjectGroupId ?? null)))
    : candidates;
  return sorted.map((task) => {
    const base: DropdownOption = {
      value: task.id,
      label: task.title || "未命名任务",
      group: groupName(task.groupId),
    };
    if (lockedGroup && (task.groupId ?? null) !== (subjectGroupId ?? null)) {
      return { ...base, disabled: true, detail: "跨组不能同队" };
    }
    if (task.queueId == null && TERMINAL.includes(task.status)) {
      return { ...base, disabled: true, detail: `${TASK_STATUS_LABELS[task.status]} · 排后面会立刻跑` };
    }
    return {
      ...base,
      detail: task.queueId != null
        ? `队列第 ${(task.queuePosition ?? 0) + 1} / ${queueSize(task.queueId)} 位`
        : TASK_STATUS_LABELS[task.status],
    };
  });
}

/** 把 taskId 排到 target 之后,返回落进的队列 id。 */
export async function placeTaskAfter(taskId: string, target: TaskListItem): Promise<{ queueId: string }> {
  if (target.queueId != null) {
    await api.queueInsert(target.queueId, taskId, (target.queuePosition ?? 0) + 1);
    return { queueId: target.queueId };
  }
  const created = await api.queueCreate([target.id, taskId]);
  return { queueId: created.queueId };
}
