import { useMemo } from "react";
import type { TaskListItem } from "@ash/shared";
import { Pause } from "@phosphor-icons/react";
import { dispatchHolderOf, dispatchHoldPhrase } from "../../lib/dispatchHold.ts";

// 被按住的任务自己的页面上，会话最后那一行：它为什么没在跑 —— 派它的那条（或更上面的）按了
// 「全部停下」。点过去就是那一条，「接着跑」在那一格的格头上。状态词照旧是「已暂停 / 排着」，
// 这一行只补「是谁按的」。样子跟「在等哨兵」那一行同一套（monitor-wait-line.css）。
export function DispatchHeldLine({ holder, onOpen }: {
  holder: Pick<TaskListItem, "id" | "title">;
  onOpen: (taskId: string) => void;
}) {
  return (
    <section className="monitor-wait-line dispatch-held-line" aria-label="被派活的那条停下了">
      <button type="button" className="monitor-wait-line__bar" onClick={() => onOpen(holder.id)}>
        <Pause size={13} weight="fill" aria-hidden="true" />
        <span className="monitor-wait-line__label">{dispatchHoldPhrase(holder)}</span>
      </button>
    </section>
  );
}

/** 按住这一条的那条任务（没被按住是 null）。从任务列表算，别的窗口按了停 / 接着跑跟着变。 */
export function useDispatchHolder(taskId: string, allTasks: readonly TaskListItem[], enabled = true): TaskListItem | null {
  const byId = useMemo(() => (enabled ? new Map(allTasks.map((item) => [item.id, item] as const)) : null), [allTasks, enabled]);
  return byId ? dispatchHolderOf(taskId, byId) : null;
}
