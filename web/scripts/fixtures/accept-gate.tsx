import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { AcceptanceControls } from "../../src/acceptance/AcceptanceControls.tsx";
import { AcceptGateWaitCard } from "../../src/review/AcceptGateWaitCard.tsx";
import { TaskStatusDot } from "../../src/components/TaskStatusDot.tsx";
import { useTasks } from "../../src/lib/useTasks.ts";
import { deriveTaskStatusIndicator } from "../../src/lib/useTaskReadState.ts";
import "../../src/styles/global.css";

// 验收前置命令那两处表面的测试舞台：验收台（默认，真的 AcceptanceControls —— 前置命令只是它前提列里
// 的一行，要验「这一行红/在跑/读不出来时主按钮放不放」就得连主按钮和确认层一起摆上），以及主会话页
// 回复框上方那条折叠条（`?wait=1`，摆在一条仿真的 .task-reply-rail 上 —— 它的折叠/展开靠 flex
// 换行，脱离那条 rail 就验不出真实几何）。两者都自己拉状态、自己判要不要出现。
//
// 验收台这一侧没有「意图」回调了：跳过、重跑都是确认层里「运行」那一勾，测试直接看发给 /accept
// 的请求体。`?stage=` 摆已验收的回执；「保护状态」切归档 / 任务在跑 / 宿主那道关（团队验收台的
// 「共享执行者还没跑完」那一类）。
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
  mergeTargetBranch: "main",
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

function DeskFixture({ params }: { params: URLSearchParams }) {
  const [notice, setNotice] = useState("");
  const [updated, setUpdated] = useState<Task | null>(null);
  const [guard, setGuard] = useState(params.get("guard") ?? "none");
  const current = updated ?? task({ stage: params.get("stage") ?? "verified" } as Partial<Task>);
  return <main className="single-review-workspace" style={{ minHeight: "100vh" }}>
    <AcceptanceControls
      className="acc-desk"
      task={{ ...current, archived: guard === "archived", status: guard === "running" ? "running" : current.status }}
      onTaskUpdated={setUpdated}
      notify={setNotice}
      block={guard === "blocked" ? { text: "审查进行中" } : null}
      lead={<b>验收台</b>}
    />
    <label>保护状态<select aria-label="保护状态" value={guard} onChange={event => setGuard(event.target.value)}>
      <option value="none">正常</option><option value="archived">已归档</option>
      <option value="running">执行中</option><option value="blocked">审查进行中</option>
    </select></label>
    <p role="status" aria-label="操作结果">{notice}</p>
  </main>;
}

function Fixture() {
  const params = new URLSearchParams(location.search);
  const [notice, setNotice] = useState("");
  const [taskId, setTaskId] = useState("gate-task");
  const [mounted, setMounted] = useState(true);
  if (params.get("dots") === "1") return <TaskDotsFixture />;
  if (params.get("wait") === "1") {
    return <main style={{ maxWidth: 760, padding: 24, margin: "auto" }}>
      <h1>验收前置命令卡</h1>
      <div className="task-reply-rail">
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
  return <DeskFixture params={params} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
