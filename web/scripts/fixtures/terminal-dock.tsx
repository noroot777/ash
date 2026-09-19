import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectView } from "@ash/shared";
import type { TerminalSessionInfo } from "../../src/lib/api.ts";
import "../../src/styles/global.css";
import "../../src/styles/status-bar.css";
import "../../src/styles/terminal.css";
import { ProjectTerminal } from "../../src/workspace/ProjectTerminal.tsx";
import { StatusBar } from "../../src/workspace/StatusBar.tsx";
import { useTerminalDock } from "../../src/workspace/useTerminalDock.ts";

// 底部坞的账本 + 它的两个表面:状态栏上那排「开着的终端」和展开后的抽屉。
// 用例见 scripts/test-terminal-dock.mjs。

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const project: ProjectView = {
  id: "p-one",
  name: "测试项目",
  repoPath: "/workspace/p-one",
  workflowId: null,
  useWorktreeDefault: false,
  previewCommand: null,
  previewConfig: null,
  commandsConfig: null,
  acceptCommit: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  health: { exists: true, isRepo: true, dirty: false, branch: "main" },
  myRole: "admin",
};

const session = (patch: Partial<TerminalSessionInfo> & { id: string }): TerminalSessionInfo => ({
  projectId: project.id,
  cwd: project.repoPath,
  shell: "/bin/zsh",
  name: "会话",
  commandId: null,
  startedAt: 1,
  exitCode: null,
  stoppedByUser: false,
  groupAlive: true,
  ...patch,
});

// server 上留着的现场:一个活的交互 shell + 一条常用命令的日志会话。
let sessions: TerminalSessionInfo[] = [
  session({ id: "s-shell", name: "测试项目", startedAt: 10 }),
  session({ id: "s-dev", name: "网页前端", commandId: "dev", startedAt: 20 }),
];

/** 每次写操作都记下来,用例断言「看一眼」不会建 shell、✕ 真的结束了会话。 */
const calls: string[] = [];
const trace = (entry: string) => {
  calls.push(entry);
  document.getElementById("calls")!.textContent = JSON.stringify(calls);
};

// xterm 的日志流:fixture 里没有真会话可连,给一个不发事件的壳,免得每个 pane 挂一条失败连接。
class QuietEventSource {
  close() {}
  addEventListener() {}
  removeEventListener() {}
  onmessage: unknown = null;
  onerror: unknown = null;
  onopen: unknown = null;
}
(window as unknown as { EventSource: unknown }).EventSource = QuietEventSource;

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { pathname } = new URL(href, location.origin);
  const method = (init?.method ?? "GET").toUpperCase();
  const list = pathname === `/api/projects/${project.id}/terminal/sessions`;
  if (list && method === "GET") return reply({ sessions });
  if (list && method === "POST") {
    trace("create");
    const created = session({ id: `s-new-${sessions.length}`, name: "测试项目 2", startedAt: 30 });
    sessions = [...sessions, created];
    return reply(created);
  }
  const one = pathname.match(/^\/api\/projects\/[^/]+\/terminal\/sessions\/([^/]+)$/);
  if (one && method === "DELETE") {
    trace(`delete:${one[1]}`);
    sessions = sessions.filter((item) => item.id !== one[1]);
    return reply({});
  }
  if (pathname.startsWith("/api/")) return reply({});
  return realFetch(input as never, init);
};

function Fixture() {
  const [notices, setNotices] = useState<string[]>([]);
  const notify = useCallback((message: string) => setNotices((all) => [...all, message]), []);
  const terminal = useTerminalDock({ project, enabled: true, notify });
  return (
    <div className="workspace-system-layout" style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div style={{ flex: 1 }} />
      {terminal.open && <ProjectTerminal project={project} dock={terminal} notify={notify} />}
      <StatusBar currentProject={project} taskMode={false} canUseTerminal connected terminal={terminal} />
      <pre id="calls" data-testid="calls" hidden>[]</pre>
      <pre data-testid="notices" hidden>{JSON.stringify(notices)}</pre>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
