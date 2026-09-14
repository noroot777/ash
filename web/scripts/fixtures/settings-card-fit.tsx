// 设置卡片体检台：把历史上「穿模」过的那几张卡摆在一起，喂**撑得住的最坏数据**
// （长得离谱的远端地址、继承来的长邮箱、profile 全列都有值），断言在 test-settings-card-fit.mjs。
//
// 挑这两块的理由：
//  · 项目设置面板 —— 卡片里既有「一行一个设置项」，又有直接挂在卡片上的说明段（预览那
//    三段）和自带排版的 Git 远端列表。贴边那次就出在这儿。
//  · 执行器 Profile —— 卡片里装的是一张宽表，宽度撑不下时该由表自己横向滚动，而不是
//    把整张分组卡连同「新增」按钮一起顶到卡片外面。
//
// 数据一律往**长**里给：短数据下这类毛病看不出来，正是它们能在仓库里反复复发的原因。
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentExecutorProfile, AuthState, ProjectView } from "@ash/shared";
import type { ProjectPreviewConfig } from "@ash/shared/preview";
import "../../src/styles/global.css";
// 设置页那几节的样式由 SettingsPage 自己引，照它的顺序补齐（providers 必须排在
// agents 之后，两边有共用的表单基础样式，顺序换了层叠结果就变了）。
import "../../src/settings/agents-settings.css";
import "../../src/settings/providers-settings.css";
import "../../src/settings/executors-settings.css";
import { AuthContext } from "../../src/auth/authContext.ts";
import { ProjectSettingsPanel } from "../../src/settings/ProjectSettingsPanel.tsx";
import { AgentProfilesSection } from "../../src/settings/AgentProfilesSection.tsx";

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const previewConfig = (): ProjectPreviewConfig => ({
  mode: "script",
  proxy: "auto",
  services: [],
  primaryServiceId: null,
  launch: "frontend",
});

const project: ProjectView = {
  id: "p-fit",
  name: "一个名字写得很长的项目，长到足以把这一行撑开",
  repoPath: "/Users/someone/code/a-rather-long-repository-path/with/more/segments",
  workflowId: null,
  useWorktreeDefault: false,
  previewCommand: "npm run dev -- --port $PORT",
  previewConfig: previewConfig(),
  createdAt: "2026-09-01T00:00:00.000Z",
  health: { exists: true, isRepo: true, dirty: false, branch: "main" },
  myRole: "admin",
};

const gitConfig = {
  identity: {
    isRepo: true,
    userName: { value: "someone", scope: "inherited" },
    // 继承来的邮箱是一整个不可断的长词：不允许它把这一行顶出卡片。
    userEmail: { value: "a-very-long-mailbox-name@an-even-longer-domain.example.com", scope: "inherited" },
    sshKeyPath: null,
    sshCommand: { value: null, scope: null },
    remotes: [
      { name: "origin", url: "https://github.com/some-organisation/a-repository-with-a-long-name.git", https: true },
      { name: "upstream", url: "git@github.com:another-organisation/an-even-longer-repository-name.git", https: false },
    ],
  },
  credential: null,
};

window.fetch = async (input: RequestInfo | URL): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { pathname } = new URL(href, location.origin);
  if (pathname === "/api/host") return reply({ platform: "linux", sep: "/", home: "/root", canPickDirectory: false });
  if (pathname === "/api/projects/check") return reply({ exists: true, isRepo: true, dirty: false, branch: "main" });
  if (pathname === "/api/workflows") return reply([]);
  if (pathname.endsWith("/git")) return reply(gitConfig);
  return reply({});
};

// claude 有「CLI 配置」列（最宽的那一档栅格），codex 没有：两种列数都摆上。
const profiles: AgentExecutorProfile[] = [
  {
    id: "claude-ccb",
    name: "claude@一个很长的供应商名字",
    type: "claude",
    target: { kind: "local" },
    model: "claude-opus-5-20260514",
    reasoningEffort: "high",
    speed: "standard",
    providerId: "ccb",
    configOverrides: { contextTokens: 400_000, autoCompactThreshold: 80 },
    extraArgs: ["--settings", "~/very/long/path/to/claude-settings.json"],
    isDefault: true,
  },
  {
    id: "codex-local",
    name: "codex@local",
    type: "codex",
    target: { kind: "local" },
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
    speed: "fast",
    isDefault: true,
  },
] as AgentExecutorProfile[];

const providers = [{
  id: "ccb",
  name: "一个很长的供应商名字",
  protocol: "anthropic",
  baseUrl: "https://a-relay-with-a-long-hostname.example.com",
  model: "claude-opus-5-20260514",
  protocolConversionEnabled: false,
  modelListMode: "pinned",
  pinnedModels: ["claude-opus-5-20260514", "claude-sonnet-5"],
  context1mModels: ["claude-opus-5-20260514"],
  hasKey: true,
  createdAt: "2026-09-01T00:00:00.000Z",
}] as never;

const authState: AuthState = { mode: "single", needsSetup: false, user: null, rootDir: null, homeDir: "/root" };

function Fixture() {
  const [current, setCurrent] = useState<ProjectView>(project);
  const notify = useCallback(() => {}, []);
  return (
    <AuthContext.Provider value={{ state: authState, refresh: async () => {} }}>
      {/* 卡片宽度跟着这个容器走：测试改视口宽度，卡片就跟着窄下去。 */}
      <main className="settings-main" style={{ width: "min(880px, calc(100% - 32px))", margin: "24px auto" }}>
        <ProjectSettingsPanel project={current} onUpdated={setCurrent} onDeleted={() => {}} notify={notify} />
        <AgentProfilesSection
          profiles={profiles}
          providers={providers}
          loading={false}
          detecting={false}
          detected={null}
          registeringKey={null}
          onDetect={() => {}}
          onRegister={() => {}}
          onProfileChanged={() => {}}
          onProfileAdded={() => {}}
          onProfilesDeleted={() => {}}
          notify={notify}
        />
      </main>
    </AuthContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
