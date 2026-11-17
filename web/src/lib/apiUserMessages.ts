// R 键那张「我说过的话」的端点（server/src/user-messages.ts）。单独一份同 apiTaskMemos.ts：
// api.ts 的端点清单已经顶到单文件 700 行上限，调用点仍然只写 `api.userMessagesOf(…)`。
import { request } from "./apiClient.ts";
import type { UserMessageHits, UserMessagesOf } from "@ash/shared/user-messages";

export const userMessageApi = {
  /** 这几个任务里我说过的话，从 cursor（缺省 = 最新）往前一页，页内旧的在前；`older` 接着往前读。 */
  userMessagesOf: (taskIds: readonly string[], cursor: string | null, signal?: AbortSignal): Promise<UserMessagesOf> =>
    request("/user-messages/of", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskIds, cursor }),
      signal,
    }),
  /** 哪些任务里我说的话对得上这些词（空白分词、都得出现），各几句。 */
  userMessageHits: (query: string, signal?: AbortSignal): Promise<UserMessageHits> =>
    request(`/user-messages/hits?${new URLSearchParams({ q: query.trim() })}`, { signal }),
};
