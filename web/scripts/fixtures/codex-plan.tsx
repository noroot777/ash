import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentEvent, Session, Task } from "@navi/shared";
import { AgentTurnBody } from "../../src/components/AgentTurnBody.tsx";
import { buildConversationItems, conversationToMarkdown } from "../../src/task-detail/conversationModel.ts";
import { ReplyBox } from "../../src/task-detail/ReplyBox.tsx";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import { LeftDrawerProvider, useLeftDrawerHost } from "../../src/components/LeftDrawer.tsx";
import "../../src/styles/global.css";

const at = "2026-11-19T01:00:00.000Z";
const finalText = "# 周额度管理台 HTML Demo\n\n## 交付目标\n\n先制作**独立、可点击的 HTML demo**，确认页面和操作方式后再改造正式系统。\n\n## 已确认的规则\n\n- 每周一北京时间 `00:00` 重置额度。\n- 调整立即生效，保留已用金额。\n- 账号与令牌双向绑定，组外隔离。\n\n| 页面 | 重点 |\n| --- | --- |\n| 人员与令牌 | 周额度、已用和剩余 |\n| 账号池 | 公共账号与专属账号 |\n\n## 验证\n\n```ts\nconst quota = weeklyBudget * multiplier;\n```\n\n不修改正式数据库与转发链路。";
type State = { events: AgentEvent[]; ended: boolean; failed: boolean };
const initial: State = { events: [], ended: false, failed: false };
const taskBase = {
  id: "plan-fixture", projectId: "fixture", title: "Codex 计划模式", body: "", mode: "single", status: "running",
  agentType: "codex", executorId: "codex-main", archived: false, labels: [], dependsOn: [], resumeDependsOn: [],
  createdAt: at, updatedAt: at, planMode: true,
  planScopes: [{ agentType: "codex", executorId: "codex-plan", executorLabel: "codex@规划", isTaskOwner: true }],
} as unknown as Task;

function Fixture() {
  const [state, setState] = useState<State>(() => JSON.parse(localStorage.getItem("codex-plan-state") ?? "null") ?? initial);
  const [sent, setSent] = useState("");
  const [sendingFailure, setSendingFailure] = useState(false);
  const drawer = useLeftDrawerHost({ resetKey: "plan-fixture" });
  const change = (next: State) => { localStorage.setItem("codex-plan-state", JSON.stringify(next)); setState(next); setSent(""); };
  const task = { ...taskBase, status: state.ended ? "paused" : "running", ...(sent ? { planMode: false, planScopes: [] } : {}) } as Task;
  const session = {
    id: "plan-session", taskId: task.id, role: "single", agentType: "codex", executor: "codex@规划", executorId: "codex-plan",
    startedAt: at, turnStartedAt: at, endedAt: state.ended ? "2026-11-19T01:02:00.000Z" : null,
    turnModel: "gpt-6.1-sol", turnReasoningEffort: "xhigh",
    turnEnds: state.ended ? { [at]: "2026-11-19T01:02:00.000Z" } : {},
    turnOutcomes: state.ended ? { [at]: state.failed ? "failed" : "completed" } : {},
  } as unknown as Session;
  const trace = state.events.filter((event): event is Extract<AgentEvent, { kind: "plan" | "thinking" | "tool" }> =>
    ["plan", "thinking", "tool"].includes(event.kind),
  ).map((event, index) => ({ seq: index + 1, at, turnStartedAt: at, event }));
  const items = buildConversationItems([{ session, output: "", trace }], [session], []);
  return <LeftDrawerProvider value={drawer.api}>
    <main style={{ maxWidth: 980, margin: "0 auto", padding: "24px 18px", minHeight: "100dvh" }}>
      <nav style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 24 }}>
        <button onClick={() => change(initial)}>重置计划</button>
        <button onClick={() => change({ ...initial, events: [
          { kind: "thinking", text: "正在核对权限边界" },
          { kind: "tool", name: "exec", detail: "rg quota server/src" },
          { kind: "plan", id: "proposal-1", text: "", status: "streaming" },
        ] })}>开始拟定</button>
        <button onClick={() => change({ ...state, events: [...state.events, { kind: "plan", id: "proposal-1", text: "# 草稿标题\n\n尚未定稿的内容", status: "streaming", delta: true }] })}>追加草稿</button>
        <button onClick={() => change({ ...state, ended: true, events: [...state.events, { kind: "plan", id: "proposal-1", text: finalText, status: "complete" }] })}>完成计划</button>
        <button onClick={() => change({ ...state, ended: true })}>中止拟定</button>
        <button onClick={() => change({ ...state, ended: true, failed: true })}>规划异常结束</button>
        <label><input type="checkbox" checked={sendingFailure} onChange={(event) => setSendingFailure(event.target.checked)} />模拟发送失败</label>
      </nav>
      <div className="task-message-content">
        {items.map((item) => item.kind === "agent" ? <AgentTurnBody key={item.id} segments={item.segments} running={!state.ended} /> : null)}
      </div>
      <ReplyBox task={task} hasConversation conversationItems={items} onSend={async (text, attachments, options) => {
        if (sendingFailure) throw new Error("网络暂不可用，计划仍然保留");
        setSent(JSON.stringify({ text, attachments, ...options }));
        return { started: true };
      }} />
      {sent && <pre aria-label="实施请求">{sent}</pre>}
      <output aria-label="导出计划" style={{ display: "none" }}>{conversationToMarkdown(items, task)}</output>
      {drawer.drawer}
    </main>
  </LeftDrawerProvider>;
}
createRoot(document.getElementById("root")!).render(<DraftProvider><Fixture /></DraftProvider>);
