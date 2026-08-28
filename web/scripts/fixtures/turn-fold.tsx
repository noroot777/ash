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

function Turn({ name, initialRunning }: { name: string; initialRunning: boolean }) {
  const [running, setRunning] = useState(initialRunning);
  const [nonce, setNonce] = useState(0);
  return (
    <div className="task-message task-message--agent" data-case={name}>
      <span className="task-message-avatar" aria-hidden="true">A</span>
      <div className="task-message-content">
        <button type="button" data-role="end-turn" onClick={() => setRunning(false)}>结束回合</button>
        <button type="button" data-role="restart-turn" onClick={() => setRunning(true)}>重新开跑</button>
        <button type="button" data-role="repaint" onClick={() => setNonce(nonce + 1)}>触发重绘 {nonce}</button>
        <AgentTurnBody segments={segments} running={running} />
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
  </StrictMode>,
);
