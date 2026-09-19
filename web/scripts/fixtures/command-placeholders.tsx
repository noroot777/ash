import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectView } from "@ash/shared";
import "../../src/styles/global.css";
import "../../src/styles/commands-launcher.css";
import { ProjectCommandsSettings } from "../../src/settings/ProjectCommandsSettings.tsx";
import { CommandsLauncher } from "../../src/workspace/CommandsLauncher.tsx";

// 常用命令的两面各摆一份:设置里的 Shell 编辑器(多行 / 自适应高度 / 拖底边)和侧栏顶行那颗 ▶ 的
// 执行入口(带 `{{占位符}}` 就先弹框收值)。用例见 scripts/test-command-placeholders.mjs。

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const project = (commandsConfig: ProjectView["commandsConfig"]): ProjectView => ({
  id: "p-one",
  name: "第一个项目",
  repoPath: "/workspace/p-one",
  workflowId: null,
  useWorktreeDefault: false,
  previewCommand: null,
  previewConfig: null,
  commandsConfig,
  acceptCommit: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  health: { exists: true, isRepo: true, dirty: false, branch: "main" },
  myRole: "admin",
});

/** 每次启停调用都记下来,用例断言请求体里带的占位符取值。 */
const calls: { path: string; body: unknown }[] = [];

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { pathname } = new URL(href, location.origin);
  // 会话事实:这个项目开着一个交互 shell(不是常用命令),另一个项目的 dev server 在跑。
  // 两者都不该点亮侧栏顶行那颗 ▶ —— 它只说当前项目的常用命令。
  if (/^\/api\/projects\/[^/]+\/terminal\/sessions$/.test(pathname)) {
    return reply({ sessions: [
      { id: "s-shell", projectId: "p-one", cwd: "/workspace/p-one", shell: "/bin/zsh", name: "第一个项目", commandId: null, startedAt: 1, exitCode: null, stoppedByUser: false, groupAlive: true },
      { id: "s-other", projectId: "p-two", cwd: "/workspace/p-two", shell: "/bin/zsh", name: "别家的 dev server", commandId: "dev", startedAt: 2, exitCode: null, stoppedByUser: false, groupAlive: true },
    ] });
  }
  const command = pathname.match(/^\/api\/projects\/([^/]+)\/commands\/([^/]+)\/(start|stop|restart)$/);
  if (command) {
    calls.push({ path: pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    document.getElementById("calls")!.textContent = JSON.stringify(calls);
    return reply({ session: null });
  }
  const update = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (update && init?.method === "PATCH") {
    const patch = JSON.parse(String(init.body)) as Partial<ProjectView>;
    return reply({ ...project(null), ...patch });
  }
  if (pathname.startsWith("/api/")) return reply({});
  return realFetch(input as never, init);
};

function Fixture() {
  const [current, setCurrent] = useState<ProjectView>(() => project({
    service: { command: "npm -w web run dev", restartCommand: null },
    commands: [
      { id: "checkout", name: "切分支", command: "git checkout {{分支}}\ngit status" },
      { id: "plain", name: "构建", command: "npm run build" },
    ],
  }));
  const [notices, setNotices] = useState<string[]>([]);
  const notify = useCallback((message: string) => setNotices((all) => [...all, message]), []);
  return <>
    <main style={{ width: "min(900px, calc(100% - 32px))", margin: "24px auto 60px" }}>
      <ProjectCommandsSettings project={current} onUpdated={setCurrent} notify={notify} />
      <pre data-testid="notices">{JSON.stringify(notices)}</pre>
      <pre data-testid="config">{JSON.stringify(current.commandsConfig)}</pre>
    </main>
    <CommandsLauncher
      currentProject={current}
      canUseTerminal
      onOpenCommandLog={() => {}}
      onManageCommands={() => {}}
      notify={notify}
    />
    <pre id="calls" data-testid="calls">[]</pre>
  </>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
