// 回复框上方那条 rail 的回归夹具。
//
// 钉的是**孤儿 DOM**那一幕（任务 z2lq7MAWeKx7 实测）：rail 上的「在等 N 个哨兵」每次重
// 渲染多出一张，长开的页面上攒了几十张，而数据侧只有 1 条在跑。所以夹具必须用真的
// `TaskReplyRail` + 真的 wait 卡（哨兵那张 2026-11 挪进了会话，现在只剩门禁那张）—— 它是 React 对一条 children 列表怎么比对的产物，
// 脱开真实的渲染-提交过程（手搓几个 div、或只断言组件返回值）一点都复现不出来。
//
// **两张卡的 key 在这里故意都给成裸 `task.id`**（出事那一版 TaskDetail 的原样）：这条列表
// 的 key 由调用方给，而 rail 自己必须在任何 key 下都不漏节点。给成不一样的就等于把被测的
// 那件事从夹具里拿掉了 —— 哪天 rail 里那层 Fragment 隔离被删掉，断言还会照样通过。
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { AcceptGateWaitCard } from "../../src/review/AcceptGateWaitCard.tsx";
import { TaskReplyRail } from "../../src/task-detail/TaskReplyRail.tsx";
import "../../src/styles/global.css";

const TASK_ID = "rail-task";

const task = {
  id: TASK_ID,
  title: "rail",
  status: "paused",
  mode: "single",
  workflowMode: "free",
  parentId: null,
  archived: false,
  // 在队列里 = 接力入口恒不给 = 这条列表前面那一位恒为 `false`。正是它把 React 从逐位
  // 比对推到按 key 查表那条路上去的（见 TaskReplyRail 里那段注释）。
  queueId: "q-1",
  queuePosition: 1,
  handoff: null,
} as unknown as Task;

function Fixture() {
  // 重渲染计数器:泄漏是「每次重渲染多留一张」,所以要能按出任意多次重渲染。
  const [renders, setRenders] = useState(0);
  return (
    <main style={{ padding: 16 }}>
      <button type="button" data-testid="rerender" onClick={() => setRenders((n) => n + 1)}>重渲染</button>
      <output data-testid="renders">{renders}</output>
      {/* 派审 / 预览 / 接力那几颗键 2026-11 挪进了回复框里那一行（reply-3），这条只剩状态。 */}
      <TaskReplyRail
        gateWait={<AcceptGateWaitCard key={task.id} taskId={TASK_ID} expected notify={() => undefined} />}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
