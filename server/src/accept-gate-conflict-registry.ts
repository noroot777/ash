// 「这一份合并预览冲突已经交给任务了」的记忆。验收台据它把那一行从「与 X 冲突」换成「任务正在
// 解决冲突」：不记的话，交出去之后任务在跑、冲突还在，那一行照旧摆着「让任务解决」，像没按过。
//
// 认的是**同一份冲突**：任务分支头和目标分支头都没动。任务把目标分支合进来并提交之后分支头就变了，
// 这份记忆自然作废（那时冲突多半已经没了，状态接口会重判）。只放内存：ash 重启后只是那一行回到
// 「与 X 冲突」，再按一次照样交得出去，不需要落库。
type Handed = { at: string; head: string | null; targetCommit: string };
const handed = new Map<string, Handed>();

export function noteConflictHandoff(taskId: string, head: string | null, targetCommit: string): void {
  handed.set(taskId, { at: new Date().toISOString(), head, targetCommit });
}

export function conflictHandedAt(taskId: string, head: string | null, targetCommit: string): string | null {
  const row = handed.get(taskId);
  if (!row) return null;
  if (row.head === head && row.targetCommit === targetCommit) return row.at;
  handed.delete(taskId);
  return null;
}
