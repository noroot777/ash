import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { AcceptGateCard } from "../../src/review/AcceptGateCard.tsx";
import { AcceptGateWaitCard } from "../../src/review/AcceptGateWaitCard.tsx";
import { TaskStatusDot } from "../../src/components/TaskStatusDot.tsx";
import { useTasks } from "../../src/lib/useTasks.ts";
import { deriveTaskStatusIndicator } from "../../src/lib/useTaskReadState.ts";
import "../../src/styles/global.css";

// 验收前置命令那两处表面的测试舞台：验收台上那张卡，以及主会话页回复框上方那条折叠条
// （`?wait=1`，摆在一条仿真的 .task-reply-rail 上 —— 它的折叠/展开靠 flex 换行，脱离
// 那条 rail 就验不出真实几何）。两者都自己拉状态、自己判要不要出现，把整个验收台搬进来
// 只会把真正要验的东西埋在一堆无关请求里。
const task = (over: Partial<Task>): Task => ({
  id: "gate-task",
  projectId: "proj-1",
  title: "门禁卡",
  body: "",
  mode: "single",
  status: "done",
  stage: "verified",
  labels: [],
  dependsOn: [],
  resumeDependsOn: [],
  agentType: "claude",
  useWorktree: true,
  workflowMode: "free",
  createdAt: "2026-10-23T00:00:00.000Z",
  updatedAt: "2026-10-23T00:00:00.000Z",
  ...over,
} as unknown as Task);

function TaskDotsFixture() {
  const { tasks } = useTasks();
  return <main style={{ maxWidth: 760, padding: 24, margin: "auto" }}>
    <h1>任务后台状态</h1>
    {tasks.map(row => {
      const workers = tasks.filter(worker => worker.parentId === row.id);
      const indicator = deriveTaskStatusIndicator(row, workers);
      return <p key={row.id} data-task-id={row.id} style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {indicator && <TaskStatusDot indicator={indicator} surface={row.mode === "team" ? "team" : "workspace"} />}
        {row.title}
      </p>;
    })}
  </main>;
}

function Fixture() {
  const params = new URLSearchParams(location.search);
  const [notice, setNotice] = useState("");
  const [intent, setIntent] = useState("");
  const [taskId, setTaskId] = useState("gate-task");
  const [mounted, setMounted] = useState(true);
  if (params.get("dots") === "1") return <TaskDotsFixture />;
  if (params.get("wait") === "1") {
    return <main style={{ maxWidth: 760, padding: 24, margin: "auto" }}>
      <h1>验收前置命令卡</h1>
      <div className="task-reply-rail">
        <button type="button" className="task-reply-rail-button">派审查</button>
        {/* expected = 任务投影里那个「此刻有命令在跑」：状态读失败时这条靠它仍然出现。 */}
        {mounted && <AcceptGateWaitCard taskId={taskId} expected={params.get("expected") === "1"} notify={setNotice} />}
      </div>
      {params.get("switch") === "1" && <>
        <button onClick={() => setTaskId("other-task")}>切任务</button>
        <button onClick={() => setMounted(false)}>卸载提示</button>
      </>}
      <p role="status" aria-label="操作结果">{notice}</p>
    </main>;
  }
  return <main style={{ maxWidth: 760, padding: 24, margin: "auto" }}>
    <h1>验收前置命令卡</h1>
    <AcceptGateCard
      task={task({ stage: params.get("stage") ?? "verified" } as Partial<Task>)}
      notify={setNotice}
      onIntent={(value) => setIntent(value)}
      disabled={params.get("disabled") === "1"}
    />
    <p role="status" aria-label="操作结果">{notice}</p>
    <output aria-label="验收意图">{intent}</output>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
