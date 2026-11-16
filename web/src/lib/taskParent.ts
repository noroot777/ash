import type { Task, TaskListItem } from "@ash/shared";

// 一条任务「上面那一条」是谁、怎么称呼这层关系。任务头、侧栏那颗来源图标、命令面板都读这一份
// （画法在 components/TaskOrigin.tsx）。
//
// 收在别人名下（dispatchedBy）有两种来路，称呼不一样：
//   · 派出去的（智能体在回合里建的、你从回复框 / 派活单派的）—— 「派它的任务」；
//   · 从那条里切出来的（裁定「转成独立任务」、合并结果审查的修复任务）—— 它不是谁派的，照旧说
//     「来自任务」。认它的事实跟服务端同一个（server/src/task-dispatch.ts 的 isCarvedOut）：系统建的、
//     而且收在自己的来源（originTaskId）名下。光看后半句不够：你或智能体派出去的任务也可以同时
//     回链到派它的那条，那仍是派出去的活。

export type TaskParentLink = {
  taskId: string;
  task: TaskListItem | undefined;
  kind: "team" | "dispatch" | "origin";
};

type Linked = Pick<TaskListItem, "parentId" | "dispatchedBy" | "originTaskId" | "creationOrigin" | "baseTaskId">;

export function taskModeLabel(mode: Task["mode"]): string {
  if (mode === "duet") return "讨论";
  if (mode === "team") return "团队";
  return "任务";
}

export function taskParentLink(task: Linked, allTasks: readonly TaskListItem[]): TaskParentLink | null {
  // 执行者首先属于直接派出它的团队；旧数据即使同时带来源任务，也以团队为准。
  // 其次是派它的那条任务（dispatchedBy）：侧栏里它就收在那一条下面，来源说的得是同一条。
  const creator = task.creationOrigin?.kind === "agent" ? task.creationOrigin.taskId : null;
  const taskId = task.parentId ?? task.dispatchedBy ?? task.originTaskId ?? creator ?? task.baseTaskId;
  if (!taskId) return null;
  const carvedOut = task.creationOrigin?.kind === "system" && task.dispatchedBy === task.originTaskId;
  const dispatched = !!task.dispatchedBy && !carvedOut;
  return {
    taskId,
    task: allTasks.find((item) => item.id === taskId),
    kind: task.parentId ? "team" : dispatched ? "dispatch" : "origin",
  };
}

export function taskParentMode(link: TaskParentLink): Task["mode"] {
  return link.kind === "team" ? "team" : (link.task?.mode ?? "single");
}

export function taskParentRelation(link: TaskParentLink): string {
  if (link.kind === "team") return "所属团队";
  return link.kind === "dispatch" ? "派它的任务" : `来自${taskModeLabel(taskParentMode(link))}`;
}
