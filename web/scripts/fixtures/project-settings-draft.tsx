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
// 但**它不跟着浏览器刷新一起消失** —— 所以这里存 localStorage，不是模块级变量：刷新页面不是
// 重启服务端，作业该还在那儿（第 3 轮审查复现「刷新后旧的成功结果又被填回输入框」正靠这一点）。
const JOB_KEY = `${storageKey}:assist-job`;
const SEQ_KEY = `${storageKey}:assist-seq`;
let assist: PreviewAssistState | null = JSON.parse(localStorage.getItem(JOB_KEY) ?? "null") as PreviewAssistState | null;
const setAssist = (next: PreviewAssistState | null) => {
  assist = next;
  localStorage.setItem(JOB_KEY, JSON.stringify(next));
};
// 服务端自报的实例身份：ash 重启才会变。前端靠它把「重启吞了」和「终态自己过期了」分开。
// 同样得存住 —— 刷新后实例又变回原值就等于「没重启过」，那条测不成了。
const INSTANCE_KEY = `${storageKey}:assist-instance`;
let assistInstance = localStorage.getItem(INSTANCE_KEY) ?? "inst-1";
localStorage.setItem(INSTANCE_KEY, assistInstance);
const restartAssistInstance = () => {
  assistInstance = `inst-${Date.now()}`;
  localStorage.setItem(INSTANCE_KEY, assistInstance);
};
// 下一次 POST 装成「请求发出去了但回不来」—— 服务端那边已经接单，浏览器这边只拿到一个错。
// "succeeded" 这一档更狠：接单之后作业还跑完了、还成功了，丢掉的只是那一发的响应。
let assistDropNextPost: false | "running" | "succeeded" = false;
// 作业身份每次**新开**时换一个 —— 真实的那份是 reservePreviewAssistJob() 里的 id()。
// 注意所有权不看它:看的是 POST 带上来的 claim(见下面的 POST 分支)。
let assistSeq = Number(localStorage.getItem(SEQ_KEY) ?? "0");
const nextAssistSeq = () => {
  assistSeq += 1;
  localStorage.setItem(SEQ_KEY, String(assistSeq));
};
const succeeded = (patch: Partial<PreviewAssistState> = {}): Partial<PreviewAssistState> => ({
  status: "succeeded",
  phase: "done",
  step: "已在 http://localhost:14611/ 上真的起来过一次",
  script: "npm run dev -- --port $PORT",
  url: "http://localhost:14611/",
  endedAt: "2026-09-26T00:02:00.000Z",
  attempts: [{ round: 1, script: "npm run dev -- --port $PORT", ok: true, url: "http://localhost:14611/", reason: null, log: "ready in 300ms" }],
  ...patch,
});
const assistJob = (patch: Partial<PreviewAssistState>): PreviewAssistState => ({
  jobId: `job-${assistSeq}`,
  projectId: "p-one",
  claim: "",
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
      const claim = String((JSON.parse(String(init.body ?? "{}")) as { claim?: unknown }).claim ?? "");
      // **撞上已经在跑的那份就原样交回去,不新开**——真实端点就是这么做的
      // (reservePreviewAssistJob 的 fresh=false)。关键是 claim 保持原主:点击方一比就知道
      // 「这不是我开的」,不会把别人跑出来的脚本填进自己的输入框(第 5 轮审查)。
      if (assist?.status !== "running") {
        nextAssistSeq();
        setAssist(assistJob({ claim }));
      }
      // 服务端照样接单了(真实实现是同步预占的)，只是这一发的响应回不到浏览器。
      if (assistDropNextPost) {
        if (assistDropNextPost === "succeeded") setAssist(assistJob({ ...succeeded(), claim }));
        assistDropNextPost = false;
        throw new TypeError("Failed to fetch");
      }
      return reply({ job: assist, instance: assistInstance });
    }
    if (init?.method === "DELETE") {
      if (assist?.status === "running") setAssist({ ...assist, status: "canceled", phase: "done", step: "已取消", error: "已取消", endedAt: "2026-09-26T00:01:00.000Z" });
      return reply({ canceled: true, job: assist, instance: assistInstance });
    }
    return reply({ job: assist, instance: assistInstance });
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
        <button type="button" data-testid="assist-restart" onClick={() => { setAssist(null); restartAssistInstance(); }}>
          假装 ash 重启
        </button>
        {/* 跟上面那颗的区别只在实例身份没变：作业是自己跑完、终态过了 10 分钟被清掉的。
            这一档说成「重启」就是让用户去查一台根本没重启过的 ash。 */}
        <button type="button" data-testid="assist-expire" onClick={() => { setAssist(null); }}>
          假装结果过期
        </button>
        <button type="button" data-testid="assist-drop-post" onClick={() => { assistDropNextPost = "running"; }}>
          假装启动请求断线
        </button>
        {/* 响应丢了 ≠ 没跑起来：服务端接单之后照样跑完、还成功了。那次验证是真的，不能被一句
            「Failed to fetch」丢掉（第 3 轮审查复现）。 */}
        <button type="button" data-testid="assist-drop-post-succeeded" onClick={() => { assistDropNextPost = "succeeded"; }}>
          假装断线前已经成功
        </button>
        {/* 别处（另一个页面、另一个人）点的那一份正在跑：这台浏览器从没点过，本地没有任何追踪。
            它必须一路只读到底 —— 连它成功之后都不许动输入框（第 4 轮审查复现）。 */}
        <button type="button" data-testid="assist-foreign-running" onClick={() => { nextAssistSeq(); setAssist(assistJob({ claim: "别处那一页的 claim" })); }}>
          假装别处正在跑
        </button>
        <button
          type="button"
          data-testid="assist-succeed"
          onClick={() => { setAssist(assistJob({ ...succeeded(), jobId: assist?.jobId ?? `job-${assistSeq}`, claim: assist?.claim ?? "" })); }}
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
