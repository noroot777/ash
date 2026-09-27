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
// **每次都从存储里读**，不留模块级副本：同一个浏览器的两个标签页各有一份自己的 window.fetch，
// 副本一留，A 那页让作业成功了 B 那页的假服务端还在回旧状态 —— 而真实服务端是一份、两页都看得见
// （⑪ 那条双标签回归就靠这个）。
const readAssist = (): PreviewAssistState | null =>
  JSON.parse(localStorage.getItem(JOB_KEY) ?? "null") as PreviewAssistState | null;
const setAssist = (next: PreviewAssistState | null) => localStorage.setItem(JOB_KEY, JSON.stringify(next));
// 服务端自报的实例身份：ash 重启才会变。前端靠它把「重启吞了」和「终态自己过期了」分开。
// 同样得存住 —— 刷新后实例又变回原值就等于「没重启过」，那条测不成了。
const INSTANCE_KEY = `${storageKey}:assist-instance`;
localStorage.setItem(INSTANCE_KEY, localStorage.getItem(INSTANCE_KEY) ?? "inst-1");
const assistInstance = (): string => localStorage.getItem(INSTANCE_KEY) ?? "inst-1";
const restartAssistInstance = () => localStorage.setItem(INSTANCE_KEY, `inst-${Date.now()}`);
// 下一次 POST 装成「请求发出去了但回不来」—— 服务端那边已经接单，浏览器这边只拿到一个错。
// "succeeded" 这一档更狠：接单之后作业还跑完了、还成功了，丢掉的只是那一发的响应。
let assistDropNextPost: false | "running" | "succeeded" = false;
// 作业身份每次**新开**时换一个 —— 真实的那份是 reservePreviewAssistJob() 里的 id()。
// 注意所有权不看它:看的是 POST 带上来的 claim(见下面的 POST 分支)。
const assistSeq = (): number => Number(localStorage.getItem(SEQ_KEY) ?? "0");
const nextAssistSeq = () => localStorage.setItem(SEQ_KEY, String(assistSeq() + 1));
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
/** 第二轮真跑出来的那一条,跟 succeeded() 默认那条不一样(见 assist-succeed-other)。 */
const OTHER_SCRIPT = "npm run preview:new -- --port $PORT";
const assistJob = (patch: Partial<PreviewAssistState>): PreviewAssistState => ({
  jobId: `job-${assistSeq()}`,
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

// **作业恰好在刷新那一瞬跑完**：armed 之后下一次页面加载时就把它落成终态，所以新文档第一次 GET
// 读到的直接是 succeeded、压根没见过 running（第 12 轮审查复现这一段时序，那时可信的刷新接力
// 反而被当成「没看着它跑」，要用户再点一次「用这条替换」）。放在模块初始化里执行，比测试自己去
// 拼一份终态 JSON 靠得住 —— 终态长什么样只有这里说得准。
const SUCCEED_ON_BOOT_KEY = `${storageKey}:assist-succeed-on-boot`;
if (localStorage.getItem(SUCCEED_ON_BOOT_KEY)) {
  localStorage.removeItem(SUCCEED_ON_BOOT_KEY);
  const live = readAssist();
  if (live?.status === "running") setAssist({ ...live, ...succeeded() });
}

// **刷新后的第一次状态读取卡在路上**：真实网络就是会这样，而这段时间里页面已经能用了 —— 用户
// 完全可以先往启动脚本里敲几行。这一段时序是第 13 轮审查的复现要件：终态到达时框里那份已经不是
// 「点下去那一刻」的内容，谁拿它当基准谁就会把用户刚写的顶掉。标记同样得活过那次刷新，所以走
// localStorage 而不是模块级变量。
const HOLD_GET_KEY = `${storageKey}:assist-hold-next-get`;
let holdFirstGet = localStorage.getItem(HOLD_GET_KEY) ? 1800 : 0;
localStorage.removeItem(HOLD_GET_KEY);

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
      if (readAssist()?.status !== "running") {
        nextAssistSeq();
        setAssist(assistJob({ claim }));
      }
      // 服务端照样接单了(真实实现是同步预占的)，只是这一发的响应回不到浏览器。
      if (assistDropNextPost) {
        if (assistDropNextPost === "succeeded") setAssist(assistJob({ ...succeeded(), claim }));
        assistDropNextPost = false;
        throw new TypeError("Failed to fetch");
      }
      return reply({ job: readAssist(), instance: assistInstance() });
    }
    if (init?.method === "DELETE") {
      const live = readAssist();
      if (live?.status === "running") setAssist({ ...live, status: "canceled", phase: "done", step: "已取消", error: "已取消", endedAt: "2026-09-26T00:01:00.000Z" });
      return reply({ canceled: true, job: readAssist(), instance: assistInstance() });
    }
    // **先把这一刻的状态定下来,再压住响应**——真实服务端就是这样:它在收到请求那一刻照实回答,
    // 慢的是回程。压住之后再去读一遍,等于让这条响应捎回未来的状态,那就测不着「旧响应晚到」了
    // (第 15 轮审查复现的正是这一段:打开页面时问的那一句「现在有作业吗」答的是「没有」,
    // 它却在点完按钮之后才落地)。
    const payload = { job: readAssist(), instance: assistInstance() };
    if (holdFirstGet) {
      const wait = holdFirstGet;
      holdFirstGet = 0;
      await new Promise((done) => setTimeout(done, wait));
    }
    return reply(payload);
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
          onClick={() => {
            const live = readAssist();
            setAssist(assistJob({ ...succeeded(), jobId: live?.jobId ?? `job-${assistSeq()}`, claim: live?.claim ?? "" }));
          }}
        >
          假装真起来了
        </button>
        {/* 同上,但给的是**另一条**脚本:一轮填过 A、下一轮真跑出来的是 C,两条得分得开。 */}
        <button
          type="button"
          data-testid="assist-succeed-other"
          onClick={() => {
            const live = readAssist();
            setAssist(assistJob({
              ...succeeded({
                script: OTHER_SCRIPT,
                attempts: [{ round: 1, script: OTHER_SCRIPT, ok: true, url: "http://localhost:14611/", reason: null, log: "ready in 300ms" }],
              }),
              jobId: live?.jobId ?? `job-${assistSeq()}`,
              claim: live?.claim ?? "",
            }));
          }}
        >
          假装真起来了(另一条)
        </button>
        {/* 上面那颗是「现在就成功」；这颗是「下一次页面加载时它已经成功了」—— 刷新那一瞬跑完的那种。 */}
        <button
          type="button"
          data-testid="assist-succeed-on-boot"
          onClick={() => { localStorage.setItem(SUCCEED_ON_BOOT_KEY, "1"); }}
        >
          假装刷新期间就成功
        </button>
        {/* 跟上面那颗配着用：刷新后的第一次状态读取压在路上，页面已经能用、用户已经能改输入框。 */}
        <button
          type="button"
          data-testid="assist-hold-next-get"
          onClick={() => { localStorage.setItem(HOLD_GET_KEY, "1"); }}
        >
          假装刷新后首次读取很慢
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
