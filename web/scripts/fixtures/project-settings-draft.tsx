// 项目设置里三个输入框的**草稿**不能被后台刷新吞掉（断言在 test-project-settings-draft.mjs）。
//
// 复现的是真实链路：WorkspaceShell 拿到 `/projects/:id/health` 的结果就
// `setProjects(... => ({ ...project, health }))` —— 项目对象**换了个身份**，内容一个字没变。
// 这个请求在进设置页时发一次，之后每有任务结算（settlementVersion）还会再发。面板那边
// 如果拿整个 project 当 effect 依赖，每次都会把三个框重置回服务端的值：用户正在输预览
// 命令，两三秒后框自己空了、保存按钮变灰，全程没有任何提示。
//
// 所以这里摆两颗按钮，分别对应那两件事：
//   · 「健康刷新」= 同一个项目换对象身份 → 草稿必须**留着**
//   · 「换个项目」= project.id 变了 → 草稿必须**冲掉**（那是另一个项目的设置）
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AuthState, ProjectView } from "@ash/shared";
// global.css 必须排在组件之前 —— `main.tsx` 就是这个顺序。
import "../../src/styles/global.css";
import { AuthContext } from "../../src/auth/authContext.ts";
import { ProjectSettingsPanel } from "../../src/settings/ProjectSettingsPanel.tsx";

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// 这一屏只测「草稿会不会被冲掉」，周边的只读端点给个能过的最小答复就行。
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { pathname } = new URL(href, location.origin);
  if (pathname === "/api/host") return reply({ platform: "linux", sep: "/", home: "/root", canPickDirectory: false });
  if (pathname === "/api/projects/check") {
    return reply({ exists: true, isRepo: true, dirty: false, branch: "main" });
  }
  if (pathname === "/api/workflows") return reply([]);
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
  if (pathname.startsWith("/api/")) return reply({});
  return realFetch(input as never, init);
};

const authState: AuthState = {
  mode: "single",
  needsSetup: false,
  user: null,
  rootDir: null,
  homeDir: "/root",
};

const project = (id: string, name: string): ProjectView => ({
  id,
  name,
  repoPath: `/workspace/${id}`,
  workflowId: null,
  previewCommand: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  health: { exists: true, isRepo: true, dirty: false, branch: "main" },
  myRole: new URLSearchParams(location.search).has("member") ? "member" : "admin",
});

function Fixture() {
  const [current, setCurrent] = useState<ProjectView>(() => project("p-one", "第一个项目"));
  const [notices, setNotices] = useState<string[]>([]);
  const notify = useCallback((message: string) => setNotices((all) => [...all, message]), []);
  return (
    <AuthContext.Provider value={{ state: authState, refresh: async () => {} }}>
      <main style={{ width: "min(900px, calc(100% - 32px))", margin: "24px auto" }}>
        <button
          type="button"
          data-testid="health-refresh"
          // WorkspaceShell 就是这么干的：只补一个 health，内容不变、对象身份变了。
          onClick={() => setCurrent((p) => ({ ...p, health: { ...p.health, dirty: !p.health.dirty } }))}
        >
          模拟项目健康刷新
        </button>
        <button type="button" data-testid="switch-project" onClick={() => setCurrent(project("p-two", "第二个项目"))}>
          换个项目
        </button>
        <ProjectSettingsPanel
          project={current}
          onUpdated={setCurrent}
          onDeleted={() => {}}
          notify={notify}
        />
        <pre data-testid="notices">{JSON.stringify(notices)}</pre>
      </main>
    </AuthContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
