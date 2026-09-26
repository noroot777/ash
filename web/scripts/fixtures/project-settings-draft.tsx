import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentExecutorProfile, AuthState, ProjectView } from "@ash/shared";
import type { PreviewAssistState } from "@ash/shared/preview-assist";
import type { DetectedPreviewService, ProjectPreviewConfig } from "@ash/shared/preview";
import "../../src/styles/global.css";
import { AuthContext } from "../../src/auth/authContext.ts";
import { ProjectSettingsPanel } from "../../src/settings/ProjectSettingsPanel.tsx";

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const emptyPreview = (): ProjectPreviewConfig => ({
  mode: "script",
  proxy: "auto",
  services: [],
  primaryServiceId: null,
  launch: "frontend",
});

const freshProject = (id: string, name: string): ProjectView => ({
  id,
  name,
  repoPath: `/workspace/${id}`,
  workflowId: null,
  useWorktreeDefault: false,
  previewCommand: null,
  previewConfig: emptyPreview(),
  createdAt: "2026-09-01T00:00:00.000Z",
  health: { exists: true, isRepo: true, dirty: false, branch: "main" },
  myRole: "admin",
});

const caseId = new URLSearchParams(location.search).get("case") ?? "manual";
const storageKey = `ash-project-settings-fixture:${caseId}`;

function readProjects(): Record<string, ProjectView> {
  const raw = localStorage.getItem(storageKey);
  if (raw) return JSON.parse(raw) as Record<string, ProjectView>;
  const projects = {
    "p-one": freshProject("p-one", "第一个项目"),
    "p-two": freshProject("p-two", "第二个项目"),
  };
  localStorage.setItem(storageKey, JSON.stringify(projects));
  return projects;
}

function writeProject(project: ProjectView) {
  const projects = readProjects();
  projects[project.id] = project;
  localStorage.setItem(storageKey, JSON.stringify(projects));
}

function loadProject(id: string): ProjectView {
  return { ...structuredClone(readProjects()[id]), myRole: new URLSearchParams(location.search).has("member") ? "member" : "admin" };
}

const detectedServices: DetectedPreviewService[] = [
  {
    id: "web",
    name: "网页前端",
    command: "cd web\nnpm run dev -- --port $PORT",
    enabled: false,
    kind: "web",
    directory: "web",
  },
  {
    id: "api",
    name: "接口服务",
    command: "cd server\nnpm run dev -- --port $PORT",
    enabled: false,
    kind: "service",
    directory: "server",
  },
];

// 执行器注册表。**不能让它落到下面那条 `{}` 兜底上**：项目设置页里的「AI 协助填写」要用
// 它算候选，拿到一个对象就是 `profiles.map is not a function`，整页白屏（第 1 轮审查复现过）。
const executorProfiles: AgentExecutorProfile[] = [
  { id: "a-claude", name: "claude@local·opus", type: "claude", isDefault: true },
  { id: "a-codex", name: "codex@local·gpt-5.6", type: "codex", isDefault: true },
];

// 「AI 协助」那台短命作业的假服务端。真实的那份是内存态（server/src/preview-assist.ts），
// 所以这里也就是一个模块级变量 —— 连带能演「ash 重启把它吞了」：把它清成 null。
let assist: PreviewAssistState | null = null;
const assistJob = (patch: Partial<PreviewAssistState>): PreviewAssistState => ({
  jobId: "job-1",
  projectId: "p-one",
  status: "running",
  phase: "thinking",
  round: 1,
  maxRounds: 3,
  executorLabel: "claude@local·opus",
  step: "第 1 轮：claude@local·opus 正在读这个项目，判断该怎么起",
  say: "",
  attempts: [],
  script: null,
  url: null,
  error: null,
  startedAt: "2026-09-26T00:00:00.000Z",
  endedAt: null,
  ...patch,
});

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { pathname } = new URL(href, location.origin);
  if (pathname === "/api/host") return reply({ platform: "linux", sep: "/", home: "/root", canPickDirectory: false });
  if (pathname === "/api/agents") return reply(structuredClone(executorProfiles));
  if (pathname === "/api/projects/check") {
    return reply({ exists: true, isRepo: true, dirty: false, branch: "main" });
  }
  if (pathname === "/api/workflows") return reply([]);
  const assistRoute = pathname.match(/^\/api\/projects\/[^/]+\/preview\/assist$/);
  if (assistRoute) {
    if (init?.method === "POST") {
      assist = assistJob({});
      return reply({ job: assist });
    }
    if (init?.method === "DELETE") {
      if (assist?.status === "running") assist = { ...assist, status: "canceled", phase: "done", step: "已取消", error: "已取消", endedAt: "2026-09-26T00:01:00.000Z" };
      return reply({ canceled: true, job: assist });
    }
    return reply({ job: assist });
  }
  if (pathname.endsWith("/git")) return reply({
    identity: {
      isRepo: true,
      userName: { value: null, scope: null },
      userEmail: { value: null, scope: null },
      sshKeyPath: null,
      sshCommand: { value: null, scope: null },
      remotes: [],
    },
    credential: null,
  });
  const detection = pathname.match(/^\/api\/projects\/([^/]+)\/preview\/detect$/);
  if (detection) return reply({ services: structuredClone(detectedServices), truncated: false });
  const update = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (update && init?.method === "PATCH") {
    const current = loadProject(decodeURIComponent(update[1]));
    const patch = JSON.parse(String(init.body)) as Partial<ProjectView>;
    const next = { ...current, ...patch };
    writeProject(next);
    return reply(next);
  }
  if (pathname.startsWith("/api/")) return reply({});
  return realFetch(input as never, init);
};

const baseAuthState: AuthState = {
  mode: "single",
  needsSetup: false,
  user: null,
  rootDir: null,
  homeDir: "/root",
};

function Fixture() {
  const [current, setCurrent] = useState<ProjectView>(() => loadProject("p-one"));
  const [authMode, setAuthMode] = useState<AuthState["mode"]>("single");
  const [notices, setNotices] = useState<string[]>([]);
  const notify = useCallback((message: string) => setNotices((all) => [...all, message]), []);
  return (
    <AuthContext.Provider value={{ state: { ...baseAuthState, mode: authMode }, refresh: async () => {} }}>
      <main style={{ width: "min(900px, calc(100% - 32px))", margin: "24px auto" }}>
        <button
          type="button"
          data-testid="health-refresh"
          onClick={() => setCurrent((project) => ({ ...project, health: { ...project.health, dirty: !project.health.dirty } }))}
        >
          模拟项目健康刷新
        </button>
        <button type="button" data-testid="server-refresh" onClick={() => setCurrent(loadProject(current.id))}>
          刷新已存项目
        </button>
        <button type="button" data-testid="mode-single" onClick={() => setAuthMode("single")}>
          切到单人模式
        </button>
        <button type="button" data-testid="mode-multi" onClick={() => setAuthMode("multi")}>
          切到多人模式
        </button>
        <button type="button" data-testid="switch-project" onClick={() => setCurrent(loadProject("p-two"))}>
          换个项目
        </button>
        {/* AI 协助这台作业是内存态的：ash 一重启服务端就只会回 `job: null`。这颗按钮演的
            就是那一下 —— 面板必须还看得出「我点过、它被打断了」，而不是退回初始按钮。 */}
        <button type="button" data-testid="assist-restart" onClick={() => { assist = null; }}>
          假装 ash 重启
        </button>
        <button
          type="button"
          data-testid="assist-succeed"
          onClick={() => {
            assist = assistJob({
              status: "succeeded",
              phase: "done",
              step: "已在 http://localhost:14611/ 上真的起来过一次",
              script: "npm run dev -- --port $PORT",
              url: "http://localhost:14611/",
              endedAt: "2026-09-26T00:02:00.000Z",
              attempts: [{ round: 1, script: "npm run dev -- --port $PORT", ok: true, url: "http://localhost:14611/", reason: null, log: "ready in 300ms" }],
            });
          }}
        >
          假装真起来了
        </button>
        <ProjectSettingsPanel
          project={current}
          onUpdated={setCurrent}
          onDeleted={() => {}}
          notify={notify}
        />
        <pre data-testid="notices">{JSON.stringify(notices)}</pre>
        <output data-testid="stored-projects" hidden>{localStorage.getItem(storageKey)}</output>
      </main>
    </AuthContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
