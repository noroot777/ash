import { Fragment, type ReactNode } from "react";

// 输入框正上方那一条：只放状态（docs/ui-ux-audit reply-3）。动作都挪进了框里那一行
// （TaskReplyActions.tsx），排着的消息、在传的附件由回复框自己摆。
export function TaskReplyRail({ gateWait }: {
  /**
   * 验收前置命令那一条（折叠态；`AcceptGateWaitCard` 自己判要不要出现）。哨兵那一条原来
   * 和它并排住在这里，现在挪进了会话最后（feed-7，monitors/MonitorWaitLine.tsx）。
   */
  gateWait?: ReactNode;
}) {
  return (
    <div className="task-reply-rail">
      {/* 插槽关进一个带 key 的 Fragment 里，**这一层不是装饰**（当年这里有两个插槽）。
          它们是同一条 children 列表里的兄弟，而 key 由调用方给：TaskDetail 给两张卡的都是
          `task.id`，于是列表里出现了两个同 key 的兄弟。只要这条列表前面还有一个 `false`
          （当年 `canHandoff` 为假时那颗接力按钮就是 —— 在队列里的任务恒为假），React 就会从逐位
          比对退到按 key 查表那条路；查表那张图同 key 的后者覆盖前者，于是 `monitorWait`
          匹配到 `gateWait` 的 fiber、类型不符只好新挂一份，而**旧的那份没被登记成删除**
          —— 它的 DOM 节点就永远留在这条 rail 上。每次重渲染留一张，长开的页面上几十张
          「在等 N 个哨兵」就是这么来的（任务 z2lq7MAWeKx7 实测，React 19.2.7 无任何报错：
          重复 key 的警告只在开发构建里出）。关进各自的 Fragment 之后，调用方的 key 落在
          两棵不同的子树里，再也撞不到一起，调用方想怎么取 key 都安全；Fragment 不产生
          DOM 节点，这条 rail 的 flex 几何一个像素都不变。 */}
      {gateWait ? <Fragment key="accept-gate-wait">{gateWait}</Fragment> : null}
    </div>
  );
}
