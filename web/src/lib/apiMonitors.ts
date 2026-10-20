// 哨兵：挂在任务上的长跑命令，stdout 每一行就是一条唤醒事件（server/src/monitors.ts）。
// 跟任务/会话那一摊只共用一个 taskId，所以从 `api.ts` 的端点清单里单独拎出来一份——
// 那份已经顶到单文件 700 行上限。调用点仍然只写 `api.taskMonitors(...)`。
import { id, json, request } from "./apiClient.ts";
import { normalizeMonitorDto } from "@ash/shared/monitor";
import type { MonitorRecovery, MonitorWakeTarget, TaskMonitor } from "@ash/shared/monitor";

export const monitorApi = {
  taskMonitors: (taskId: string): Promise<TaskMonitor[]> =>
    request<TaskMonitor[]>(`/tasks/${id(taskId)}/monitors`).then((rows) => rows.map(normalizeMonitorDto)),
  /** 还有没确认落地的监听事实吗（面板据此区分「还没读完」和「确实没有」）。 */
  monitorRecovery: (taskId: string): Promise<MonitorRecovery> =>
    request(`/tasks/${id(taskId)}/monitors/recovery`),
  /** `wake` = 这个哨兵醒来叫谁。只有服务端说「说不清叫谁」(`needsWakeTarget`)时才需要带。 */
  startMonitor: (
    taskId: string,
    body: { command: string; description?: string; timeoutMs?: number; wake?: MonitorWakeTarget },
  ): Promise<{ monitor: TaskMonitor; notice?: string }> =>
    request(`/tasks/${id(taskId)}/monitors`, json("POST", body)),
  stopMonitor: (monitorId: string, reason?: string): Promise<{ monitor: TaskMonitor | null }> =>
    request<{ monitor: TaskMonitor | null }>(`/monitors/${id(monitorId)}/stop`, json("POST", { reason }))
      .then((r) => ({ monitor: r.monitor ? normalizeMonitorDto(r.monitor) : null })),
  /** 哨兵日志的尾巴：事件正文里被略去的行（单批超限、合并超长）只有这里还有。 */
  // `bytes`:日志文件这一刻多大（`null` = 这一刻读不出来,老后端也没有这一列）。空行列表有三
  // 种来由（真空文件 / 读取失败 / 尾部没有完整行),只有这个字段分得开（第 1 轮审查 F4）。
  monitorLog: (monitorId: string, lines?: number): Promise<{ lines: string[]; truncated: boolean; bytes?: number | null }> =>
    request(`/monitors/${id(monitorId)}/log${lines ? `?lines=${lines}` : ""}`),
};
