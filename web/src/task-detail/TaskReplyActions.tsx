import { useRef } from "react";
import type { Task } from "@ash/shared";
import { PaperPlaneTilt } from "@phosphor-icons/react";
import type { Notify } from "../lib/notify.ts";
import { useFreeWorkflowActions } from "../free-workflow/useFreeWorkflowActions.tsx";

// 回复框里那一行左边的动作（docs/ui-ux-audit reply-3）：再审、打开预览、接力到…在明面，
// 预览日志进「更多」。共同点是「任务正跑着也得看得见、点得动」：自由工作流的派审/预览是
// 这样，把整个任务接力到另一台机器也是这样——真要接力时任务多半正卡着，藏进标题栏的溢出
// 菜单里等于要用户先猜它在哪儿（接力对话框自己会先把任务停下来）。
export function useTaskReplyActions({ task, canHandoff, onHandoff, notify }: {
  task: Task;
  /** 接力入口给不给：单飞、没归档、不在队列里、没接力出去(或还悬着)。 */
  canHandoff: boolean;
  onHandoff: () => void;
  notify: Notify;
}) {
  const moreRef = useRef<HTMLButtonElement>(null);
  const free = useFreeWorkflowActions({ task, notify, returnFocusRef: moreRef });
  const returning = task.handoff?.direction === "in"
    || (task.handoff?.direction === "out" && task.handoff.pending
      && Object.prototype.hasOwnProperty.call(task.handoff, "returnTransferId"));
  const handoffLabel = returning ? "移回..." : "接力到...";
  const actions = (
    <>
      {free.buttons}
      {canHandoff && (
        <button type="button" className="reply-act" aria-label={handoffLabel} onClick={onHandoff}>
          <PaperPlaneTilt size={14} />
          <span>{handoffLabel}</span>
        </button>
      )}
      {free.dialogs}
    </>
  );
  return { actions, moreItems: free.logItem ? [free.logItem] : [], moreRef };
}
