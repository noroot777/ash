// 收编智能体自建的工作区（服务端 task-worktree-move-routes.ts / task-worktree-adopt.ts）。单独一份：`api.ts`
// 已经顶到单文件 700 行上限。调用点仍然只写 `api.foreignWorktrees(…)`。
import { id, json, request } from "./apiClient.ts";

/** 这条任务会话里用到过、Navi 没管到的一个 worktree。`blocker` 是此刻收编不了的原因。 */
export type ForeignWorktree = { path: string; seenAs: string; branch: string; head: string; blocker: string | null };

export const worktreeAdoptApi = {
  // 还没重启到新版的服务端没有这个端点：当成没有，别在信息格里报错。
  foreignWorktrees: (taskId: string): Promise<{ worktrees: ForeignWorktree[]; mergeTarget: string | null }> =>
    request<{ worktrees: ForeignWorktree[]; mergeTarget: string | null }>(`/tasks/${id(taskId)}/foreign-worktrees`)
      .catch(() => ({ worktrees: [], mergeTarget: null })),
  adoptWorktree: (taskId: string, path: string, mergeTargetBranch: string | null): Promise<{ adopted: { path: string; branch: string } }> =>
    request(`/tasks/${id(taskId)}/worktree-adopt`, json("POST", { path, mergeTargetBranch })),
};
