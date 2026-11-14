import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task, TaskListItem } from "@ash/shared";
import { api, type TaskCommit, type TaskDiffResult } from "../../src/lib/api.ts";
import { json, request } from "../../src/lib/apiClient.ts";
import { AcceptanceControls } from "../../src/acceptance/AcceptanceControls.tsx";
import { AcceptRoute } from "../../src/acceptance/AcceptRoute.tsx";
import { useBranchPlan } from "../../src/review/useBranchPlan.ts";
import { WorkflowInspector } from "../../src/workflow/WorkflowInspector.tsx";
import { BranchPlanProbe } from "./branch-plan-probe.tsx";
import { ReviewDiffViewer } from "../../src/review/ReviewDiffViewer.tsx";
import { TaskChangeSummary } from "../../src/task-detail/TaskChangeSummary.tsx";
import "../../src/styles/global.css";

// 服务端台子（server/scripts/test-branch-acceptance.ts --serve）只挂了分支、验收、diff、项目那几族路由。
// 验收台另外要读的两份事实在这里补「无事可报」的答复（台子回 404 时才补），免得各自落成一行
// 「读不出来」：自由工作流状态（没有审查链）、任务工作区的 SCM 概览（没有未提交文件）。
const nativeFetch = window.fetch.bind(window);
const cleanScm = { root: { path: "/fixture", source: "worktree", branch: null, gitRepo: true }, taskRunning: false, readOnly: null,
  acceptanceCommitBlock: null, acceptanceAutoCommit: { action: "disabled", reason: "项目未开启验收前自动提交" }, commits: [],
  status: { branch: { head: null, detached: false, oid: null, upstream: null, ahead: null, behind: null },
    staged: [], unstaged: [], untracked: [], merge: [], operation: null, truncated: false } };
const stubs: [RegExp, (taskId: string) => unknown][] = [
  [/^\/api\/tasks\/([^/]+)\/free-workflow$/, taskId => ({ taskId, selectedReviewerId: null, stateVersion: 1, workspaceHead: null,
    workspaceDirty: null, reviewReservation: { armed: false, reviewerId: null, checkMode: null, retryLimit: null, note: null, override: null, runId: null },
    reviewTurn: false, preview: { running: false }, executions: [], reviews: [] })],
  [/^\/api\/tasks\/([^/]+)\/scm$/, () => cleanScm],
];
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (!init?.method || init.method === "GET") {
    const stub = stubs.find(([pattern]) => pattern.test(url.pathname));
    if (stub) {
      const real = await nativeFetch(input, init);
      if (real.status !== 404) return real;
      const taskId = decodeURIComponent(url.pathname.match(stub[0])![1]);
      return new Response(JSON.stringify(stub[1](taskId)), { headers: { "content-type": "application/json" } });
    }
  }
  return nativeFetch(input, init);
};

// 后台静默重验失败在验收台上一个字都不出（staleReason 不进版面）。测试要先确认那次失败**真的落进了
// 共享的依赖状态**，再断言版面没动——这里另挂一个订阅者把它念出来。它和验收台共用同一份缓存，不多发请求。
function PlanObserver({ task }: { task: TaskListItem }) {
  const plan = useBranchPlan(task);
  return <output aria-label="依赖后台重验失败">{plan.staleReason ?? ""}</output>;
}

function Fixture() {
  const [task, setTask] = useState<Task | null>(null);
  const [diff, setDiff] = useState<TaskDiffResult | null>(null);
  const [commits, setCommits] = useState<{ branch: string | null; commits: TaskCommit[] } | null>(null);
  const [notice, setNotice] = useState("");
  const [creationError, setCreationError] = useState("");
  const [mounted, setMounted] = useState(true);
  const [guard, setGuard] = useState("none");
  const taskId = new URLSearchParams(location.search).get("task") || "case1-parent";
  useEffect(() => { void api.task(taskId).then(setTask); }, [taskId]);
  // 换任务才清空；同一任务刷新时留着上一份，第一行走向不跟着每次任务更新闪没再出来。
  useEffect(() => { setDiff(null); setCommits(null); }, [taskId]);
  useEffect(() => {
    let alive = true;
    void api.taskDiff(taskId).then(value => { if (alive) setDiff(value); });
    void api.taskCommits(taskId).then(value => { if (alive) setCommits(value); }, () => { if (alive) setCommits({ branch: null, commits: [] }); });
    return () => { alive = false; };
  }, [taskId, task?.updatedAt]);
  if (!task) return <p>读取测试任务…</p>;
  const checkCreationError = async () => {
    try {
      await request("/tasks", { ...json("POST", { projectId: task.projectId, title: "过期来源", useWorktree: false }),
        headers: { "content-type": "application/json", "x-ash-source-task-id": task.id, "x-ash-turn-token": "stale-fixture-turn" } });
    } catch (e) { setCreationError(e instanceof Error ? e.message : String(e)); }
  };
  const shown = { ...task, archived: guard === "archived", status: guard === "running" || guard === "queued" ? guard : task.status };
  const route = diff && {
    source: diff.sourceBranch || commits?.branch || "项目当前分支",
    target: diff.targetBranch || task.acceptedTargetBranch || task.mergeTargetBranch || task.worktreeBase || "验收时确定",
    commits: commits?.commits ?? [],
    diff,
  };
  return <main style={{ maxWidth: 920, padding: 32, margin: "auto" }}>
    <h1>父子任务验收验证</h1><p>独立临时仓库与数据库中的测试任务</p>
    <nav style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 24 }}>
      {["case1-parent", "case1-child", "case2-child", "case3-parent", "case4-parent", "case5-parent", "case5-child", "case6-parent", "case6-child", "case7-parent", "case8-parent", "case9-parent", "case9-child", "case10-parent", "case10-child", "case11-child", "case12-parent", "case12-child", "case13-parent", "case13-child", "case14-parent", "case14-child", "case15-parent", "case16-child", "case17-child", "case18-child", "case19-child", "case20-child", "case21-child", "case22-child", "case23-child", "case24-child", "case24-grand", "case1-unstarted", "case1-badstart"].map(id => <a key={id} href={`?task=${id}`}>{id}</a>)}
    </nav>
    <h2>{task.title}</h2>
    {taskId === "case1-unstarted" || taskId === "case1-badstart" ? <>
      <TaskChangeSummary task={task} allTasks={[task]} onOpenReview={() => {}} />
      {diff && <ReviewDiffViewer result={diff} />}
    </> : null}
    <output aria-label="工作流游标">{task.workflowAt || "无"}</output>
    <BranchPlanProbe mounted={mounted} onToggle={() => setMounted(value => !value)}
      onDialogUpdate={async () => setTask(await api.patchTask(task.id, { labels: ["confirmation-probe"] }))}
      onUpdate={() => setTask(value => value && { ...value, updatedAt: new Date().toISOString() })} />
    <label>保护状态<select value={guard} onChange={e => setGuard(e.target.value)}>
      <option value="none">正常</option><option value="archived">已归档</option>
      <option value="running">执行中</option><option value="queued">排队中</option><option value="block">额外拦截</option>
    </select></label>
    {mounted && <>
      <PlanObserver task={shown} />
      <section aria-label="验收台"><AcceptanceControls task={shown}
        block={guard === "block" ? { text: "审查进行中" } : null} onTaskUpdated={setTask} notify={setNotice}
        lead={route ? <AcceptRoute task={shown} data={route} disabled={!!shown.archived} onTaskUpdated={setTask} notify={setNotice} /> : null} /></section>
      {["case16-child", "case17-child", "case19-child", "case20-child", "case21-child", "case22-child", "case23-child", "case24-child", "case24-grand"].includes(taskId) && diff && <section aria-label="恢复后的分支改动">
        <output aria-label="diff 文件">{diff.files.map(file => file.path).sort().join(",")}</output>
        <ReviewDiffViewer result={diff} />
      </section>}
      {task.workflow && <section aria-label="工作流侧栏入口"><WorkflowInspector task={task} onTaskUpdated={setTask} notify={setNotice} /></section>}
    </>}
    <p role="status" aria-label="操作结果">{notice}</p>
    <button onClick={() => void checkCreationError()}>检查创建来源错误提示</button>
    {creationError && <p role="alert">{creationError}</p>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
