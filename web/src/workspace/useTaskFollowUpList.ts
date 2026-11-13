import { useEffect, useState } from "react";
import type { TaskFollowUpList } from "@ash/shared";
import { api } from "../lib/api.ts";

/**
 * 悬停「追问」那一格时现取的全部追问（铺开那一下只批量取了每个任务最后一条）。
 *
 * **每次悬停都重新问，不留缓存**：会话正文没有能在前端拿到的版本号 —— 任务的 updatedAt
 * 不是（删掉一条消息不动它，第 1 轮审查实测删过的原话从缓存里又冒出来），而为了省一次
 * 只读一个任务的请求去枚举「哪些写入会改正文」守不住。悬停本来就要等 PEEK_DELAY，
 * 这一发通常在卡片弹出前后就回来了；回来之前卡片先拿铺开时取到的最后一条顶着。
 *
 * "loading" = 还没回来；"failed" = 这一发挂了（下次悬停自然再问一次）。
 */
export type FollowUpListState = TaskFollowUpList | "loading" | "failed";

export function useTaskFollowUpList(taskId: string, enabled: boolean): FollowUpListState {
  const [state, setState] = useState<{ taskId: string; value: FollowUpListState }>({ taskId, value: "loading" });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState({ taskId, value: "loading" });
    api.taskFollowUps(taskId, controller.signal)
      .then((value) => setState({ taskId, value }))
      .catch(() => { if (!controller.signal.aborted) setState({ taskId, value: "failed" }); });
    return () => controller.abort();
  }, [enabled, taskId]);

  // 别的任务的结果一帧都不拿出来。
  return state.taskId === taskId ? state.value : "loading";
}
