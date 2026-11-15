// 任务备忘的端点（server/src/task-memos.ts）。单独一份而不是并进 `api.ts`，理由跟
// 哨兵那一组一样：那份端点清单已经顶到单文件 700 行上限。调用点仍然只写 `api.taskMemos(…)`。
//
// 单条的改/删都走 `/tasks/:taskId/memos/:memoId` 而不是 `/memos/:id`：后者是**全局 id
// 路由**，整个漏在多人模式的横切闸外面（定时消息、哨兵都栽过这一跤），所以客户端这边
// 也一并要求调用方把 taskId 带上。
import { id, json, request } from "./apiClient.ts";
import type { TaskMemo, TaskMemoDigest } from "@ash/shared/task-memo";

/** 一条备忘写进去的内容：正文 + 附件路径（`POST /uploads` 回的 path）。 */
export type TaskMemoContent = { body: string; attachments?: string[] };

/**
 * 前端 build 落地即生效、服务端要等重启（两边不同时换代），这段时间里旧服务端回的备忘
 * 没有 `attachments` —— 补成空数组，别让读态在 `.length` 上崩掉。
 */
const withAttachments = (memo: TaskMemo): TaskMemo => ({ ...memo, attachments: memo.attachments ?? [] });

export const taskMemoApi = {
  taskMemos: async (taskId: string): Promise<TaskMemo[]> =>
    (await request<TaskMemo[]>(`/tasks/${id(taskId)}/memos`)).map(withAttachments),
  createTaskMemo: async (taskId: string, content: TaskMemoContent): Promise<TaskMemo> =>
    withAttachments(await request<TaskMemo>(`/tasks/${id(taskId)}/memos`, json("POST", content))),
  updateTaskMemo: async (taskId: string, memoId: string, content: TaskMemoContent): Promise<TaskMemo> =>
    withAttachments(await request<TaskMemo>(`/tasks/${id(taskId)}/memos/${id(memoId)}`, json("PATCH", content))),
  deleteTaskMemo: (taskId: string, memoId: string): Promise<{ deleted: true }> =>
    request(`/tasks/${id(taskId)}/memos/${id(memoId)}`, { method: "DELETE" }),
  /** 侧边栏铺开那一列：一批任务各自「最近更新的那条备忘 + 共几条」。没有的任务不在返回里。 */
  taskMemoDigests: (taskIds: string[]): Promise<TaskMemoDigest[]> =>
    request("/tasks/memos", json("POST", { taskIds })),
};
