import type { WorktreeMoveRequest } from "@navi/shared";

// `tasks.worktree_move_request` 那一格的读写形状（只放纯函数：task-store 的序列化要读它，
// 而办这件事的 task-worktree-move.ts 要引 git、会话、回合锁，不能反过来让 task-store 依赖它）。

export function parseWorktreeMoveRequest(raw: string | null | undefined): WorktreeMoveRequest | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<WorktreeMoveRequest>;
    if (typeof value.base !== "string" || !value.base.trim()) return null;
    return {
      base: value.base,
      mergeTargetBranch: typeof value.mergeTargetBranch === "string" && value.mergeTargetBranch.trim() ? value.mergeTargetBranch : null,
      requestedAt: typeof value.requestedAt === "string" ? value.requestedAt : "",
    };
  } catch {
    return null;
  }
}

export const serializeWorktreeMoveRequest = (request: WorktreeMoveRequest): string => JSON.stringify(request);
