import { Fragment, type ReactNode } from "react";
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
      {/* 两个插槽各自关进一个带 key 的 Fragment 里，**这一层不是装饰**。
          它们是同一条 children 列表里的兄弟，而 key 由调用方给：TaskDetail 给两张卡的都是
          `task.id`，于是列表里出现了两个同 key 的兄弟。只要这条列表前面还有一个 `false`
          （`canHandoff` 为假时那颗接力按钮就是 —— 在队列里的任务恒为假），React 就会从逐位
          比对退到按 key 查表那条路；查表那张图同 key 的后者覆盖前者，于是 `monitorWait`
          匹配到 `gateWait` 的 fiber、类型不符只好新挂一份，而**旧的那份没被登记成删除**
          —— 它的 DOM 节点就永远留在这条 rail 上。每次重渲染留一张，长开的页面上几十张
          「在等 N 个哨兵」就是这么来的（任务 z2lq7MAWeKx7 实测，React 19.2.7 无任何报错：
          重复 key 的警告只在开发构建里出）。关进各自的 Fragment 之后，调用方的 key 落在
          两棵不同的子树里，再也撞不到一起，调用方想怎么取 key 都安全；Fragment 不产生
          DOM 节点，这条 rail 的 flex 几何一个像素都不变。 */}
      {monitorWait ? <Fragment key="monitor-wait">{monitorWait}</Fragment> : null}
      {gateWait ? <Fragment key="accept-gate-wait">{gateWait}</Fragment> : null}
    </div>
  );
}
