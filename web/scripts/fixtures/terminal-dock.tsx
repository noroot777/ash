import { useCallback, useRef, useState } from "react";
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

const projectOf = (id: string, name: string): ProjectView => ({
  id,
  name,
  repoPath: `/workspace/${id}`,
  workflowId: null,
  useWorktreeDefault: false,
  previewCommand: null,
  previewConfig: null,
  commandsConfig: null,
  acceptCommit: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  health: { exists: true, isRepo: true, dirty: false, branch: "main" },
  myRole: "admin",
});

// 两个项目:第二个用来钉住「切项目不会把上一个项目的 tab 带过去、也不会平白建 shell」。
const projects = [projectOf("p-one", "测试项目"), projectOf("p-two", "第二个项目")];

const session = (patch: Partial<TerminalSessionInfo> & { id: string }): TerminalSessionInfo => ({
  projectId: "p-one",
  cwd: "/workspace/p-one",
  shell: "/bin/zsh",
  name: "会话",
  commandId: null,
  startedAt: 1,
  exitCode: null,
  stoppedByUser: false,
  groupAlive: true,
  ...patch,
});

// server 上留着的现场:第一个项目有一个活的交互 shell + 一条常用命令的日志会话;第二个项目空着。
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
  const list = pathname.match(/^\/api\/projects\/([^/]+)\/terminal\/sessions$/);
  // 会话按项目分家 —— 真服务端就是这样,前端不该看见别的项目的现场。
  if (list && method === "GET") return reply({ sessions: sessions.filter((item) => item.projectId === list[1]) });
  if (list && method === "POST") {
    trace(`create:${list[1]}`);
    const created = session({
      id: `s-new-${sessions.length}`,
      projectId: list[1],
      cwd: `/workspace/${list[1]}`,
      name: "新建会话",
      startedAt: 30 + sessions.length,
    });
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
  const [index, setIndex] = useState(0);
  const project = projects[index];
  const notify = useCallback((message: string) => setNotices((all) => [...all, message]), []);
  const terminal = useTerminalDock({ project, enabled: true, notify });
  // 常用命令点「执行」那一刻,act() 的 .then 捕获的是**当时那一只** onOpenCommandLog —— 请求
  // 回来时照样调它,哪怕人已经切走了。下面两颗按钮把这段时序拆开重演:先捕获,再切项目,再让
  // 结果落回来。(CommandsLauncher 本身在 command-placeholders 那个 fixture 里。)
  const late = useRef<{ open: (session: TerminalSessionInfo) => void; session: TerminalSessionInfo } | null>(null);
  // 每一次渲染都记下「这一帧把谁的 tab 交给了哪个项目」。切项目时旧 tab 哪怕只漏过去一帧,
  // 新项目的抽屉就会照着它去建 shell —— 用例查的是这条序列,不靠抓帧的运气。
  const renders = ((window as unknown as { __renders?: unknown[] }).__renders ??= []) as {
    project: string; tabs: string[];
  }[];
  renders.push({ project: project.id, tabs: terminal.tabs.map((tab) => tab.cwd) });
  return (
    <div className="workspace-system-layout" style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div style={{ flex: 1, padding: 16 }}>
        {/* 真应用里这一下是侧栏的项目切换(WorkspaceShell 的 currentProject 换人)。 */}
        <button type="button" onClick={() => setIndex((value) => (value + 1) % projects.length)}>切项目</button>
        <button
          type="button"
          onClick={() => { late.current = { open: terminal.openSession, session: sessions.find((item) => item.id === "s-dev")! }; }}
        >发起命令</button>
        <button type="button" onClick={() => late.current?.open(late.current.session)}>命令结果晚返回</button>
      </div>
      {terminal.open && <ProjectTerminal key={project.id} project={project} dock={terminal} notify={notify} />}
      <StatusBar currentProject={project} taskMode={false} canUseTerminal connected terminal={terminal} />
      <pre id="calls" data-testid="calls" hidden>[]</pre>
      <pre data-testid="notices" hidden>{JSON.stringify(notices)}</pre>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
