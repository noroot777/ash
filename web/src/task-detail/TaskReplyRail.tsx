import type { Task } from "@ash/shared";
import { PaperPlaneTilt } from "@phosphor-icons/react";
import { FreeWorkflowToolbar } from "../free-workflow/FreeWorkflowToolbar.tsx";

// 输入框正上方那一条快捷操作。共同点是「任务正跑着也得看得见、点得动」：自由工作流的
// 派审/预览是这样，把整个任务接力到另一台机器也是这样——真要接力时任务多半正卡着，
// 藏进标题栏的溢出菜单里等于要用户先猜它在哪儿（接力对话框自己会先把任务停下来）。
export function TaskReplyRail({
  task,
  freeToolbar,
  canHandoff,
  onHandoff,
  notify,
}: {
  task: Task;
  /** 这个任务吃自由工作流那组按钮吗（判据与 FreeWorkflowToolbar 自己的一致）。 */
  freeToolbar: boolean;
  /** 接力入口给不给：单飞、没归档、不在队列里、没接力出去(或还悬着)。 */
  canHandoff: boolean;
  onHandoff: () => void;
  notify: (message: string) => void;
}) {
  return (
    <div className="task-reply-rail">
      {freeToolbar && <FreeWorkflowToolbar task={task} notify={notify} />}
      {canHandoff && (
        <button type="button" className="task-reply-rail-button" onClick={onHandoff}>
          <PaperPlaneTilt size={13} />
          <span>接力到另一台机器</span>
        </button>
      )}
    </div>
  );
}
