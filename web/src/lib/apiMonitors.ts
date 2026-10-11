// 哨兵：挂在任务上的长跑命令，stdout 每一行就是一条唤醒事件（server/src/monitors.ts）。
// 跟任务/会话那一摊只共用一个 taskId，所以从 `api.ts` 的端点清单里单独拎出来一份——
// 那份已经顶到单文件 700 行上限。调用点仍然只写 `api.taskMonitors(...)`。
import { id, json, request } from "./apiClient.ts";
import type { TaskMonitor } from "@ash/shared/monitor";

export const monitorApi = {
  taskMonitors: (taskId: string): Promise<TaskMonitor[]> =>
    request(`/tasks/${id(taskId)}/monitors`),
  startMonitor: (
    taskId: string,
    body: { command: string; description?: string; timeoutMs?: number },
  ): Promise<{ monitor: TaskMonitor; notice?: string }> =>
    request(`/tasks/${id(taskId)}/monitors`, json("POST", body)),
  stopMonitor: (monitorId: string, reason?: string): Promise<{ monitor: TaskMonitor | null }> =>
    request(`/monitors/${id(monitorId)}/stop`, json("POST", { reason })),
  /** 哨兵日志的尾巴：事件正文里被略去的行（单批超限、合并超长）只有这里还有。 */
  monitorLog: (monitorId: string, lines?: number): Promise<{ lines: string[]; truncated: boolean }> =>
    request(`/monitors/${id(monitorId)}/log${lines ? `?lines=${lines}` : ""}`),
};
