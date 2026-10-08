// 创建完成时把任务回写进列表的合并策略(WorkspaceShell.createTask 用)。
// 列表里已有这行 = SSE 已先送达:事件在写库之后发布,至少不旧于创建/重取的 HTTP
// 响应,而且响应在途期间队列可能又变过(入队→被移出)。这时**不覆盖**——拿在途
// 快照整行替换会把更晚的 SSE 更新抹掉(第 2 轮审查:已移出的任务又显示 2/7;
// 重取 503 回退旧快照时显示「独立任务」)。快照只用于 SSE 还没来时的占位插入。
export function mergeCreatedTask<T extends { id: string }>(current: T[], created: T): T[] {
  return current.some((row) => row.id === created.id) ? current : [created, ...current];
}
