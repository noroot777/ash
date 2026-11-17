// R 键那张「我说过的话」的端点（server/src/user-messages.ts）。单独一份同 apiTaskMemos.ts：
// api.ts 的端点清单已经顶到单文件 700 行上限，调用点仍然只写 `api.userMessages(…)`。
import { request } from "./apiClient.ts";
import type { UserMessageContext, UserMessagePage } from "@ash/shared/user-messages";

export const userMessageApi = {
  /** 新的在前一页；`cursor` 是上一页回的 next，`query` 空白分词、每个词都得出现在正文或任务标题里。 */
  userMessages: (options: { query?: string; cursor?: string | null; signal?: AbortSignal } = {}): Promise<UserMessagePage> => {
    const params = new URLSearchParams();
    if (options.query?.trim()) params.set("q", options.query.trim());
    if (options.cursor) params.set("cursor", options.cursor);
    const search = params.toString();
    return request(`/user-messages${search ? `?${search}` : ""}`, { signal: options.signal });
  },
  /** 一句话前后的对话；sessionId 为 null 是原始需求。 */
  userMessageContext: (
    target: { taskId: string; sessionId: string | null; index: number | null },
    signal?: AbortSignal,
  ): Promise<UserMessageContext> => {
    const params = new URLSearchParams({ taskId: target.taskId });
    if (target.sessionId) {
      params.set("sessionId", target.sessionId);
      params.set("index", String(target.index ?? 0));
    }
    return request(`/user-messages/context?${params}`, { signal });
  },
};
