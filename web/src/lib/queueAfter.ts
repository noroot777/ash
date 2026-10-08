// 「排在某任务之后」的共享逻辑:候选列表构造 + 落库动作。
// 两个入口共用 —— 任务详情检查器(存量任务入队,分组已定)和新建任务面板
// (launchMode="queue",新任务的分组随目标任务)。
// 候选按用户拍板「全部列出不过滤」:不合法的置灰并在右侧灰字写明原因。
// 落库语义:目标已在队列 → 紧随其后插入;不在 → 建一条 [目标, 本任务] 的新队列。
// 推进由服务端 advanceQueue 负责:前驱全是终态时新成员会立刻被拉起。
import type { Group, Task, TaskListItem, TaskStatus } from "@ash/shared";
import { TASK_STATUS_LABELS } from "@ash/shared";
import type { DropdownOption } from "../components/Dropdown.tsx";
import { api } from "./api.ts";

const TERMINAL: readonly TaskStatus[] = ["done", "failed", "canceled"];

/** 这个任务现在还能不能谈「排队等前面跑完」:只对还没开始跑的任务有意义。
 * 团队任务排除:调度器按 mode !== "team" 过滤队列成员,入了队也永远不会被拉起。 */
export function canJoinQueue(task: Pick<TaskListItem, "status" | "parentId" | "archived" | "queueId" | "mode">): boolean {
  return task.parentId === null
    && !task.archived
    && task.queueId == null
    && task.mode !== "team"
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
    // 调度器(selectNextInQueue)把 team 成员整个过滤掉:排在它后面不会等它完成,
    // 它自己入队也不会被拉起。在支持团队终态判据前,先如实置灰,不承诺兑现不了的等待。
    if (task.mode === "team") {
      return { ...base, disabled: true, detail: "团队任务 · 队列不会等它完成" };
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

/** 把 taskId 排到 target 之后,返回落进的队列 id、本任务入队后的权威快照,以及
 * 这次变更波及的**全体成员**快照(tasks)——前驱的 queuePosition/updatedAt 同样被
 * 这次插入/建队改了,只同步本任务会让前驱在列表里保持旧状态(第 5 轮审查:前驱
 * 无队列徽标、计数「2/1」、不刷新再排一次会重复建队撞 409)。
 * 目标已在队列时按**前驱身份**(afterTaskId)插入:插入点由服务端读当前队列决定,
 * 客户端快照里的数字位置在请求在途时可能已经过期(第 1 轮审查真实复现)。
 * 快照直接来自插入/建队响应(updatedAt 已被服务端 bump):入队成功即拿到入队后
 * 状态,没有「成功后再 GET、GET 失败只能回退创建前快照」的窗口(第 4 轮审查)。 */
export async function placeTaskAfter(
  taskId: string,
  target: TaskListItem,
): Promise<{ queueId: string; task: Task | null; tasks: Task[] }> {
  const present = (items: (Task | null)[] | undefined): Task[] =>
    (items ?? []).filter((item): item is Task => item != null);
  if (target.queueId != null) {
    const res = await api.queueInsertAfter(target.queueId, taskId, target.id);
    return { queueId: target.queueId, task: res.task ?? null, tasks: present(res.tasks) };
  }
  const created = await api.queueCreate([target.id, taskId]);
  const members = present(created.tasks);
  return { queueId: created.queueId, task: members.find((item) => item.id === taskId) ?? null, tasks: members };
}
