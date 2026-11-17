// R 键那张「我说过的话」的端点（server/src/user-messages.ts）。单独一份同 apiTaskMemos.ts：
// api.ts 的端点清单已经顶到单文件 700 行上限，调用点仍然只写 `api.userMessagesOf(…)`。
import { request } from "./apiClient.ts";
import type { UserMessageHits, UserMessagesOf } from "@ash/shared/user-messages";

export const userMessageApi = {
  /** 这几个任务里我说过的每一句，旧的在前。 */
  userMessagesOf: (taskIds: readonly string[], signal?: AbortSignal): Promise<UserMessagesOf> =>
    request(`/user-messages/of?${new URLSearchParams({ taskIds: taskIds.join(",") })}`, { signal }),
  /** 哪些任务里我说的话对得上这些词（空白分词、都得出现），各几句。 */
  userMessageHits: (query: string, signal?: AbortSignal): Promise<UserMessageHits> =>
    request(`/user-messages/hits?${new URLSearchParams({ q: query.trim() })}`, { signal }),
};
