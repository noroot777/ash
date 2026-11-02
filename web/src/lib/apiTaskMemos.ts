// 任务备忘的端点（server/src/task-memos.ts）。单独一份而不是并进 `api.ts`，理由跟
// 哨兵那一组一样：那份端点清单已经顶到单文件 700 行上限。调用点仍然只写 `api.taskMemos(…)`。
//
// 单条的改/删都走 `/tasks/:taskId/memos/:memoId` 而不是 `/memos/:id`：后者是**全局 id
// 路由**，整个漏在多人模式的横切闸外面（定时消息、哨兵都栽过这一跤），所以客户端这边
// 也一并要求调用方把 taskId 带上。
import { id, json, request } from "./apiClient.ts";
import type { TaskMemo, TaskMemoDigest } from "@ash/shared/task-memo";

export const taskMemoApi = {
  taskMemos: (taskId: string): Promise<TaskMemo[]> =>
    request(`/tasks/${id(taskId)}/memos`),
  createTaskMemo: (taskId: string, body: string): Promise<TaskMemo> =>
    request(`/tasks/${id(taskId)}/memos`, json("POST", { body })),
  updateTaskMemo: (taskId: string, memoId: string, body: string): Promise<TaskMemo> =>
    request(`/tasks/${id(taskId)}/memos/${id(memoId)}`, json("PATCH", { body })),
  deleteTaskMemo: (taskId: string, memoId: string): Promise<{ deleted: true }> =>
    request(`/tasks/${id(taskId)}/memos/${id(memoId)}`, { method: "DELETE" }),
  /** 侧边栏铺开那一列：一批任务各自「最近更新的那条备忘 + 共几条」。没有的任务不在返回里。 */
  taskMemoDigests: (taskIds: string[]): Promise<TaskMemoDigest[]> =>
    request("/tasks/memos", json("POST", { taskIds })),
};
