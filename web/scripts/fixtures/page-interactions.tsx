import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectView, ScheduledMessage, Task, TaskListItem } from "@ash/shared";
import type { ScmOverview } from "../../src/lib/api.ts";
import { ScheduledMessageTray } from "../../src/components/ScheduledMessageTray.tsx";
import { WorkspaceCheck } from "../../src/acceptance/WorkspaceCheck.tsx";
import { CreateProjectDialog } from "../../src/overlays/CreateProjectDialog.tsx";
import { AuthContext } from "../../src/auth/authContext.ts";
import { AcceptanceControls } from "../../src/acceptance/AcceptanceControls.tsx";
import "../../src/styles/global.css";

const scenario = new URLSearchParams(location.search).get("scenario");
let commitAttempts = 0;
let scmReads = 0;
const scmRequests: { method: string; path: string; body: string | null }[] = [];
(window as unknown as { scmRequests: typeof scmRequests }).scmRequests = scmRequests;
let overview: ScmOverview = {
  root: { path: "/workspace/demo/.worktrees/task", branch: "task", source: "worktree", gitRepo: true }, taskRunning: scenario === "running", readOnly: null,
  acceptanceCommitBlock: scenario === "shared" ? "此任务共用项目目录，不能一键全量提交。请到源代码管理中按文件选择提交。" : null,
  acceptanceAutoCommit: scenario === "running" ? { action: "skip", reason: "任务正在运行，不能自动提交" }
    : scenario === "shared" || scenario === "outcome" ? { action: "skip", reason: "此任务共用项目目录，不能自动提交" }
    : { action: "commit", reason: "项目已开启验收前自动提交；当前预检通过，验收时将尝试提交，执行前会再次核对。" },
  status: { branch: { head: "task", detached: false, oid: "abc", upstream: null, ahead: null, behind: null },
    staged: [], unstaged: [{ path: "src/app.tsx", kind: "modified", origPath: null, conflict: null, nested: false }],
    untracked: [{ path: "notes.md", kind: "untracked", origPath: null, conflict: null, nested: false }], merge: [], operation: null, truncated: false }, commits: [],
};
const project = { id: "demo", name: "示例项目", repoPath: "/workspace/demo", acceptAutoCommit: false } as ProjectView;
const task = { id: "demo", projectId: "demo", title: "改进页面交互", body: "", labels: [], dependsOn: [], resumeDependsOn: [],
  agentType: "codex", mode: "single", status: "done", stage: "verified", useWorktree: false, workflowMode: "free", updatedAt: "1" } as Task;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  // 请求不出页面（这里就是假后端），测试要核对顺序和请求体只能读这份记录。
  if (url.pathname.startsWith("/api/tasks/demo/scm")) scmRequests.push({ method: init?.method ?? "GET", path: url.pathname, body: init?.body ? String(init.body) : null });
  if (url.pathname === "/api/host") return response({ platform: "linux", sep: "/", home: "/workspace", canPickDirectory: false });
  if (url.pathname === "/api/projects/check") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const exists = !String(body.repoPath).includes("new");
    return response({ exists, isRepo: exists, dirty: false, empty: true });
  }
  if (url.pathname === "/api/projects" && init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    return response({ ...project, ...body, id: "created" }, 201);
  }
  if (url.pathname === "/api/projects") return response([project]);
  if (url.pathname === "/api/projects/clone") return response({ ...project, name: "cloned", id: "cloned" }, 201);
  if (url.pathname === "/api/tasks/demo/scm/acceptance-commit") {
    commitAttempts += 1;
    if (scenario === "failure" && commitAttempts === 1) return response({ error: "提交失败：请配置 Git 用户信息后重试" }, 409);
    overview = { ...overview, status: { ...overview.status, staged: [], unstaged: [], untracked: [] } };
    return response({ ok: true, sha: "abc123456789", subject: "示例提交", status: overview.status });
  }
  if (url.pathname === "/api/tasks/demo/scm") {
    scmReads += 1;
    // unreadable：第一次读失败，之后照常。fresh：页面摆出来之后工作区里又多了一个文件——「提交」按下去
    // 那一刻要再读一遍，提交的是那时的清单，不是 15 秒前摆在这一行上的。
    if (scenario === "unreadable" && scmReads === 1) return response({ error: "读取工作区失败：磁盘忙" }, 500);
    if (scenario === "fresh" && scmReads === 2) {
      overview = { ...overview, status: { ...overview.status,
        untracked: [...overview.status.untracked, { path: "late.txt", kind: "untracked", origPath: null, conflict: null, nested: false }] } };
    }
    return response(overview);
  }
  // 验收台另读的几份事实：自由工作流（没有审查链）。
  if (url.pathname === "/api/tasks/demo/free-workflow") return response({ taskId: "demo", selectedReviewerId: null, stateVersion: 1,
    workspaceHead: null, workspaceDirty: null, reviewReservation: { armed: false, reviewerId: null, checkMode: null, retryLimit: null, note: null, override: null, runId: null },
    reviewTurn: false, preview: { running: false }, executions: [], reviews: [] });
  if (url.pathname === "/api/tasks/demo/accept-gate") return response({ command: null, running: null, latest: null, basis: null });
  if (url.pathname === "/api/tasks/demo/accept") {
    task.stage = "accepted";
    return response({ accepted: true, taskId: "demo", status: "done", stage: "accepted", kind: "in_place",
      autoCommit: { status: "skipped", reason: "此任务共用项目目录，不能自动提交" } });
  }
  if (url.pathname === "/api/tasks/demo") return response(task);
  throw new Error(`验证页面拒绝未声明的请求：${url.pathname}`);
};
const message = (id: string, text: string): ScheduledMessage => ({ id, text, taskId: "demo", attachments: [], agent: null,
  executorId: null, model: null, reasoningEffort: null, sessionRole: null, origin: null, mode: "queued", status: "pending",
  sendAt: `2026-10-28T00:00:0${id}Z`, createdAt: `2026-10-28T00:00:0${id}Z`, sentAt: null });
const initial = [{ ...message("1", "请先修复项目创建流程，再调整验收页面"), steerable: true }, message("2", "补充：保留现在的工作区隔离方式")];
function Fixture() {
  const [messages, setMessages] = useState(initial);
  const [dialog, setDialog] = useState(false);
  const [notice, setNotice] = useState("");
  const [acceptedTask, setAcceptedTask] = useState(task);
  return <AuthContext.Provider value={{ state: { mode: "single", user: null, needsSetup: false }, refresh: async () => {} }}>
    <main style={{ maxWidth: 960, margin: "40px auto", padding: 20 }}>
      <h1>项目与会话交互</h1><button onClick={() => setDialog(true)}>创建项目</button>
      <h2>用户消息 · 收起时可直接操作</h2>
      <ScheduledMessageTray messages={messages} loading={false} error={null} cancelingIds={new Set()}
        onWithdraw={message => { setMessages(rows => rows.filter(row => row.id !== message.id)); setNotice(`已撤回：${message.text}`); }}
        onSteer={id => { setMessages(rows => rows.filter(row => row.id !== id)); setNotice("已引导会话"); }} />
      <h2>系统消息 · 不混用用户操作</h2>
      <ScheduledMessageTray messages={[{ ...message("3", "【哨兵结束】构建检查，退出码 1。请检查错误日志"), origin: "monitor:test" },
        { ...message("4", "审查完成后投递的答复"), sessionRole: "reviewer" }]} loading={false} error={null} cancelingIds={new Set()}
        onWithdraw={() => setNotice("不应撤回系统消息")}
        onSteer={() => setNotice("不应引导系统消息")}
        onCancel={() => setNotice("仅取消这次哨兵唤醒，不停止哨兵")} />
      <h2>验收 · 未提交改动</h2>
      {scenario === "outcome" ? <AcceptanceControls task={acceptedTask} onTaskUpdated={setAcceptedTask} notify={setNotice} />
        : <div role="list" aria-label="验收前提"><WorkspaceCheck task={{ id: "demo", projectId: "demo", title: "改进页面交互", updatedAt: "1" } as TaskListItem} notify={setNotice} disabled={scenario === "disabled"} /></div>}
      <p role="status" data-testid="result">{notice}</p>
      {dialog && <CreateProjectDialog projects={[]} onClose={() => setDialog(false)} notify={setNotice}
        onCreated={created => { setDialog(false); setNotice(`已创建项目：${created.name} · ${created.repoPath}`); }} />}
    </main>
  </AuthContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
