import type { ReactNode } from "react";
import type { Task } from "@ash/shared";
import { PaperPlaneTilt } from "@phosphor-icons/react";
import type { Notify } from "../lib/notify.ts";
import { FreeWorkflowToolbar } from "../free-workflow/FreeWorkflowToolbar.tsx";

// 输入框正上方那一条快捷操作。共同点是「任务正跑着也得看得见、点得动」：自由工作流的
// 派审/预览是这样，把整个任务接力到另一台机器也是这样——真要接力时任务多半正卡着，
// 藏进标题栏的溢出菜单里等于要用户先猜它在哪儿（接力对话框自己会先把任务停下来）。
export function TaskReplyRail({
  task,
  freeToolbar,
  canHandoff,
  monitorWait,
  gateWait,
  onHandoff,
  notify,
}: {
  task: Task;
  /** 这个任务吃自由工作流那组按钮吗（判据与 FreeWorkflowToolbar 自己的一致）。 */
  freeToolbar: boolean;
  /** 接力入口给不给：单飞、没归档、不在队列里、没接力出去(或还悬着)。 */
  canHandoff: boolean;
  /**
   * 哨兵那一条（折叠态；`MonitorWaitCard` 自己管展开）。落在这条 rail 上是因为它和这里
   * 的按钮是同一类东西：**任务正跑着也得看得见**。展开后它靠 `flex-basis: 100%` 换到
   * 下一行占满——那时它是一张卡，跟按钮挤在一行会两头都读不清。
   */
  monitorWait?: ReactNode;
  /**
   * 验收前置命令那一条（折叠态；`AcceptGateWaitCard` 自己判要不要出现）。跟哨兵同一类
   * 事实、同一套骨架，所以紧挨着它放 —— 两条都在时，它们是同一行里并排的两条。
   */
  gateWait?: ReactNode;
  onHandoff: () => void;
  notify: Notify;
}) {
  const returning = task.handoff?.direction === "in"
    || (task.handoff?.direction === "out" && task.handoff.pending
      && Object.prototype.hasOwnProperty.call(task.handoff, "returnTransferId"));
  return (
    <div className="task-reply-rail">
      {freeToolbar && <FreeWorkflowToolbar task={task} notify={notify} />}
      {canHandoff && (
        <button type="button" className="task-reply-rail-button" onClick={onHandoff}>
          <PaperPlaneTilt size={13} />
          <span>{returning ? "移回..." : "接力到..."}</span>
        </button>
      )}
      {monitorWait}
      {gateWait}
    </div>
  );
}
