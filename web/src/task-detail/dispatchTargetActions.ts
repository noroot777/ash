// 任务页回复框里「派出去的活交给谁」写回这条任务（单独成文件守 TaskDetail 的 700 行）。
import type { Task } from "@navi/shared";
import type { DispatchRunTarget } from "@navi/shared/dispatch-target";
import { api } from "../lib/api.ts";
import type { Notify } from "../lib/notify.ts";

export function saveDispatchTarget(task: Task, onTaskUpdate: (task: Task) => void, notify: Notify) {
  return async (target: DispatchRunTarget | null) => {
    onTaskUpdate(await api.setDispatchTarget(task.id, target));
    notify(target ? `以后派出去的活交给 ${[target.agentType, target.model].filter(Boolean).join(" · ")}` : "派出去的活改回同这里");
  };
}
