// 任务页回复框里跟派活单有关的两件事（单独成文件守 TaskDetail 的 700 行）：
//   · 「派出去」：交给 ash 照卡建（卡对的可以是名下派出的那一条自己摆的单，就送到那一条去）；
//   · 「派出去的活交给谁」：写回这条任务。
import type { Task, TaskListItem } from "@ash/shared";
import type { DispatchLaunchInput, DispatchRunTarget } from "@ash/shared/dispatch-plan";
import { api } from "../lib/api.ts";
import type { Notify } from "../lib/notify.ts";

export function launchPlanFromHost(notify: Notify) {
  return async (input: DispatchLaunchInput, asking: TaskListItem) => {
    const { tasks } = await api.launchDispatchPlan(asking.id, input);
    notify(`派出了 ${tasks.length} 个任务`);
  };
}

export function saveDispatchTarget(task: Task, onTaskUpdate: (task: Task) => void, notify: Notify) {
  return async (target: DispatchRunTarget | null) => {
    onTaskUpdate(await api.setDispatchTarget(task.id, target));
    notify(target ? `以后派出去的活交给 ${[target.agentType, target.model].filter(Boolean).join(" · ")}` : "派出去的活改回同这里");
  };
}
