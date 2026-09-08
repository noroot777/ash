import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { api, type TaskDiffResult } from "../../src/lib/api.ts";
import { json, request } from "../../src/lib/apiClient.ts";
import { BranchAcceptancePanel } from "../../src/review/BranchAcceptancePanel.tsx";
import { AcceptanceControls } from "../../src/team/TeamReviewWorkspace.tsx";
import { WorkflowInspector } from "../../src/workflow/WorkflowInspector.tsx";
import { BranchPlanProbe } from "./branch-plan-probe.tsx";
import { ReviewDiffViewer } from "../../src/review/ReviewDiffViewer.tsx";
import { TaskChangeSummary } from "../../src/task-detail/TaskChangeSummary.tsx";
import "../../src/styles/global.css";

function Fixture() {
  const [task, setTask] = useState<Task | null>(null);
  const [diff, setDiff] = useState<TaskDiffResult | null>(null);
  const [notice, setNotice] = useState("");
  const [creationError, setCreationError] = useState("");
  const [mounted, setMounted] = useState(true);
  const [guard, setGuard] = useState("none");
  const taskId = new URLSearchParams(location.search).get("task") || "case1-parent";
  useEffect(() => { void api.task(taskId).then(setTask); }, [taskId]);
  useEffect(() => { void api.taskDiff(taskId).then(setDiff); }, [taskId]);
  if (!task) return <p>读取测试任务…</p>;
  const checkCreationError = async () => {
    try {
      await request("/tasks", { ...json("POST", { projectId: task.projectId, title: "过期来源", useWorktree: false }),
        headers: { "content-type": "application/json", "x-ash-source-task-id": task.id, "x-ash-turn-token": "stale-fixture-turn" } });
    } catch (e) { setCreationError(e instanceof Error ? e.message : String(e)); }
  };
  return <main style={{ maxWidth: 920, padding: 32, margin: "auto" }}>
    <h1>父子任务验收验证</h1><p>独立临时仓库与数据库中的测试任务</p>
    <nav style={{ display: "flex", gap: 16, marginBottom: 24 }}>
      {["case1-parent", "case1-child", "case2-child", "case3-parent", "case4-parent", "case5-parent", "case5-child", "case6-parent", "case6-child", "case7-parent", "case8-parent", "case9-parent", "case9-child", "case1-unstarted", "case1-badstart"].map(id => <a key={id} href={`?task=${id}`}>{id}</a>)}
    </nav>
    <h2>{task.title}</h2>
    {taskId === "case1-unstarted" || taskId === "case1-badstart" ? <>
      <TaskChangeSummary task={task} allTasks={[task]} onOpenReview={() => {}} />
      {diff && <ReviewDiffViewer result={diff} />}
    </> : null}
    <output aria-label="工作流游标">{task.workflowAt || "无"}</output>
    <BranchPlanProbe mounted={mounted} onToggle={() => setMounted(value => !value)}
      onUpdate={() => setTask(value => value && { ...value, updatedAt: new Date().toISOString() })} />
    <label>保护状态<select value={guard} onChange={e => setGuard(e.target.value)}>
      <option value="none">正常</option><option value="archived">已归档</option>
      <option value="running">执行中</option><option value="queued">排队中</option><option value="block">额外拦截</option>
    </select></label>
    {mounted && <>
      <section aria-label="审查页入口"><AcceptanceControls
        task={{ ...task, archived: guard === "archived", status: guard === "running" || guard === "queued" ? guard : task.status }}
        acceptanceBlock={guard === "block" ? "审查进行中" : null} onTaskUpdated={setTask} notify={setNotice} /></section>
      <BranchAcceptancePanel task={task} notify={setNotice} onTaskUpdated={setTask} />
      {task.workflow && <section aria-label="工作流侧栏入口"><WorkflowInspector task={task} onTaskUpdated={setTask} notify={setNotice} /></section>}
    </>}
    <p role="status" aria-label="操作结果">{notice}</p>
    <button onClick={() => void checkCreationError()}>检查创建来源错误提示</button>
    {creationError && <p role="alert">{creationError}</p>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
