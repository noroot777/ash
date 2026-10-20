import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectView, Task, TaskMode } from "@ash/shared";
import { TaskComposerPanel } from "../../src/composer/TaskComposerPanel.tsx";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import { ProjectGitContext } from "../../src/workspace/ProjectGitContext.tsx";
import { useProjectGitAnnouncer } from "../../src/workspace/useProjectGitAnnouncer.ts";
import "../../src/styles/global.css";

const branchNames: Record<string, string[]> = { p1: ["main", "version-upgrade"], p2: ["release"] };
const heads: Record<string, string> = { p1: "main", p2: "release" };
const created: Record<string, unknown>[] = [];
let holdBranches = false;
let failBranches = false;
let holdCheckout = false;
let failCheckout = false;
let releaseCheckout: (() => void) | null = null;
const branchReplies: (() => void)[] = [];
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const stateOf = (projectId: string) => ({
  isRepo: true,
  root: `/tmp/${projectId}`,
  branch: { head: heads[projectId], detached: false, oid: "1234567", upstream: null, ahead: 0, behind: 0 },
  dirty: { staged: 0, unstaged: 0, untracked: 0, merge: 0 },
  operation: null,
  remotes: [],
  branches: branchNames[projectId].map((name) => ({
    name, current: name === heads[projectId], upstream: null, ahead: null, behind: null, gone: false, worktree: null,
  })),
});

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { pathname } = new URL(href, location.origin);
  const match = /^\/api\/projects\/(p[12])\/(branches|git(?:\/checkout)?)$/.exec(pathname);
  if (match) {
    const projectId = match[1];
    if (match[2] === "branches") {
      const snapshot = { branches: branchNames[projectId], current: heads[projectId] };
      const fail = failBranches;
      if (holdBranches) await new Promise<void>((resolve) => { branchReplies.push(resolve); });
      return fail ? reply({ error: "旧分支读取失败" }, 503) : reply(snapshot);
    }
    if (match[2] === "git/checkout") {
      const body = JSON.parse(String(init?.body));
      if (holdCheckout) await new Promise<void>((resolve) => { releaseCheckout = resolve; });
      if (failCheckout) { failCheckout = false; return reply({ error: "切换失败，仍在原分支" }, 409); }
      failBranches = false;
      heads[projectId] = body.branch;
      return reply({ ok: true, message: `已切换到 ${body.branch}`, state: stateOf(projectId) });
    }
    return reply(stateOf(projectId));
  }
  if (pathname === "/api/agents") return reply([{
    id: "exec-claude", name: "claude@test", type: "claude", isDefault: true,
  }]);
  if (pathname === "/api/settings") return reply({ defaultWorkflowId: null, skillRefreshSeconds: 0 });
  if (pathname === "/api/skills") return reply({ skills: [] });
  if (pathname === "/api/tasks" && init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    const task = { ...body, id: `task-${created.length + 1}`, status: "backlog",
      resolvedBase: body.worktreeBase || heads[body.projectId] };
    created.push(task);
    return reply(task);
  }
  return reply([]);
};

const projectOf = (projectId: string): ProjectView => ({
  id: projectId, name: projectId === "p1" ? "分支回归项目" : "第二项目", repoPath: `/tmp/${projectId}`,
  workflowId: null, useWorktreeDefault: true, createdAt: "2026-10-19T00:00:00.000Z",
  health: { exists: true, isRepo: true, branch: heads[projectId], dirty: false }, myRole: "admin",
});

function Fixture() {
  const [project, setProject] = useState(() => projectOf("p1"));
  const [mode, setMode] = useState<TaskMode>("single");
  const [round, setRound] = useState(0);
  const [notices, setNotices] = useState<string[]>([]);
  const [records, setRecords] = useState(created);
  const [holding, setHolding] = useState(false);
  const notify = useCallback((message: string) => setNotices((current) => [...current, message]), []);
  useProjectGitAnnouncer(notify, () => setProject((current) => projectOf(current.id)));
  return <div style={{ display: "flex", height: "100vh", flexDirection: "column" }}>
    <header style={{ display: "flex", gap: 12, padding: 16, flexWrap: "wrap" }}>
      <ProjectGitContext key={project.id} projectId={project.id} health={project.health} project={project} canManage onOpenTerminal={null} />
      <button onClick={() => setProject(projectOf(project.id === "p1" ? "p2" : "p1"))}>切换项目</button>
      <button onClick={() => { heads[project.id] = "version-upgrade"; }}>外部切到升级分支</button>
      <button onClick={() => { holdBranches = true; failBranches = false; setRound((value) => value + 1); }}>重开并延迟分支读取</button>
      <button onClick={() => { holdBranches = true; failBranches = true; setRound((value) => value + 1); }}>重开并延迟读取失败</button>
      <button onClick={() => { holdBranches = false; failBranches = false; branchReplies.splice(0).forEach((release) => release()); }}>释放分支读取</button>
      <button onClick={() => { holdCheckout = true; setHolding(true); }}>延迟下一次切换</button>
      <button onClick={() => { failCheckout = true; }}>下一次切换失败</button>
      <button onClick={() => { holdCheckout = false; releaseCheckout?.(); setHolding(false); }}>完成分支切换</button>
      <span data-testid="holding">{holding ? "切换将延迟" : "正常切换"}</span>
    </header>
    <TaskComposerPanel key={round} project={project} groups={[]} mode={mode} onModeChange={setMode}
      onCancel={() => {}} onCreated={(_task: Task) => { setRecords([...created]); setRound((value) => value + 1); }}
      onCreateGroup={async () => { throw new Error("not used"); }} onProjectUpdated={setProject} notify={notify} />
    <footer style={{ padding: 12, maxHeight: 180, overflow: "auto" }}>
      <pre data-testid="created">{JSON.stringify(records, null, 2)}</pre>
      <p data-testid="notices">{notices.join("；")}</p>
    </footer>
  </div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><DraftProvider><Fixture /></DraftProvider></StrictMode>);
