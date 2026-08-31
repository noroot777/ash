import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentContentSegment } from "../../src/task-detail/conversationModel.ts";
import { AgentTurnBody } from "../../src/components/AgentTurnBody.tsx";
import "../../src/styles/global.css";

// 一条典型的长回合：边干边说 → 最后一次动手 → 结论 → 记账（complete_task）→ 收尾。
const segments: AgentContentSegment[] = [
  { id: "s0", markdown: "我会先确认第 1 轮缺陷对应的新提交是否真正修复。\n", events: [], attachments: [] },
  { id: "s1", markdown: "", events: [{ kind: "tool", label: "Bash", detail: "npm run build" }], attachments: [] },
  { id: "s2", markdown: "真实页面已在后台标签打开并操作，附件数量可见。\n", events: [], attachments: [] },
  {
    id: "s3",
    markdown: "第 2 轮结论：verify_failed，已上报。\n",
    events: [{ kind: "tool", label: "Read", detail: "report.md" }],
    attachments: [],
  },
  { id: "s4", markdown: "", events: [{ kind: "tool", label: "mcp__harness__complete_task" }], attachments: [] },
  { id: "s5", markdown: "工作树保持干净。\n", events: [], attachments: [] },
];

// 未确认完成的失败回合：server 在正文写完之后补一条 settled.note —— .md 里是一段引用、
// trace 里是一条 error（single-run.ts）。整篇回答必须留在外面，别跟着它折进过程。
const failedSegments: AgentContentSegment[] = [
  {
    id: "f0",
    markdown: "答（只回答，未改代码）：会覆盖，而且只有一个槽。\n",
    events: [{ kind: "tool", label: "Bash", detail: "grep -rn 预约" }],
    attachments: [],
  },
  {
    id: "f1",
    markdown: "> 回合正常结束,但本回合内没有收到 complete_task 的完成确认。\n",
    events: [{ kind: "error", label: "回合正常结束,但本回合内没有收到 complete_task 的完成确认" }],
    attachments: [],
  },
];

function Turn({
  name,
  initialRunning,
  initialTaskLive = initialRunning,
  turnSegments = segments,
}: {
  name: string;
  initialRunning: boolean;
  /** 整个任务还在跑。缺省跟着回合走（回合在飞，任务当然在跑）。 */
  initialTaskLive?: boolean;
  turnSegments?: AgentContentSegment[];
}) {
  const [running, setRunning] = useState(initialRunning);
  const [taskLive, setTaskLive] = useState(initialTaskLive);
  const [nonce, setNonce] = useState(0);
  return (
    <div className="task-message task-message--agent" data-case={name}>
      <span className="task-message-avatar" aria-hidden="true">A</span>
      <div className="task-message-content">
        {/* 回合收口但任务还在跑：换下一轮、就地验证、会话行落 endedAt 都长这样。 */}
        <button type="button" data-role="end-turn" onClick={() => setRunning(false)}>结束回合</button>
        {/* 最后一步确认执行完了：任务不跑了。 */}
        <button
          type="button"
          data-role="end-task"
          onClick={() => { setRunning(false); setTaskLive(false); }}
        >
          结束任务
        </button>
        <button
          type="button"
          data-role="restart-turn"
          onClick={() => { setRunning(true); setTaskLive(true); }}
        >
          重新开跑
        </button>
        <button type="button" data-role="repaint" onClick={() => setNonce(nonce + 1)}>触发重绘 {nonce}</button>
        <AgentTurnBody segments={turnSegments} running={running} taskLive={taskLive} />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* 正在跑的回合 */}
    <Turn name="live" initialRunning />
    {/* 刷新页面后读到的历史回合：一上来就该是折好的 */}
    <Turn name="persisted" initialRunning={false} />
    {/* 任务还在跑，但这一条是它上一轮的回合：不许被自动掀开 */}
    <Turn name="history" initialRunning={false} initialTaskLive />
    {/* 未确认完成而记 failed 的回合：结算那条异常不许把整篇回答折进过程 */}
    <Turn name="failed" initialRunning={false} turnSegments={failedSegments} />
  </StrictMode>,
);
