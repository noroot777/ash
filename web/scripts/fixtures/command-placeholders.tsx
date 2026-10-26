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

const project = (commandsConfig: ProjectView["commandsConfig"], id = "p-one", name = "第一个项目"): ProjectView => ({
  id,
  name,
  repoPath: `/workspace/${id}`,
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

/** 命令列表两幕共用(切 service 配置时不该连带把列表换掉)。 */
const COMMANDS = [
  { id: "checkout", name: "切分支", command: "git checkout {{分支}}\ngit status" },
  { id: "plain", name: "构建", command: "npm run build" },
];

/** 第一个项目自己在跑的一条常用命令:只在「晚返回」那一幕出现(见下面的 __slowFact)。 */
const lateSession = { id: "s-late", projectId: "p-one", cwd: "/workspace/p-one", shell: "/bin/zsh", name: "构建", commandId: "plain", startedAt: 3, exitCode: null, stoppedByUser: false, groupAlive: true, ports: [], portsAlive: false, stop: { kind: "none" as const }, portsTruncated: false };

/**
 * 守护化的**普通常用命令**(window.__plainDaemon):端口是服务,不是服务那一行的特权 ——
 * `npm run dev` 配在列表里照样会双 fork 跑成守护进程。这一幕用来钉住「行按钮与服务头部
 * 同一套判据」(第 1 轮审查发现 3:头部有停止,同形状的普通命令行却显示执行)。
 */
const plainDaemonSession = { id: "s-plain-daemon", projectId: "p-one", cwd: "/workspace/p-one", shell: "/bin/zsh", name: "构建", commandId: "plain", startedAt: 5, exitCode: 0, stoppedByUser: false, groupAlive: false, ports: [9191], portsAlive: true, stop: { kind: "none" as const }, portsTruncated: false };

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { pathname } = new URL(href, location.origin);
  // 会话事实:这个项目开着一个交互 shell(不是常用命令),另一个项目的 dev server 在跑。
  // 两者都不该点亮侧栏顶行那颗 ▶ —— 它只说当前项目的常用命令。
  const listing = pathname.match(/^\/api\/projects\/([^/]+)\/terminal\/sessions$/);
  if (listing) {
    // __slowFact:让**第一个项目**的这次查询慢 400ms 回来,并且带上它自己在跑的一条命令 ——
    // 用例借此重演「切走之后旧事实才落回来」。其余时候一如既往,立刻回同一份。
    const slow = (window as unknown as { __slowFact?: boolean }).__slowFact === true && listing[1] === "p-one";
    // 服务会话:用例用 window.__service 切六种现场 —— 在跑 / 真·守护化(启动脚本退了,
    // 但它打印过的端口还有人听) / 启动脚本自己退了而端口上也没人(docker compose up -d
    // 那种,服务在本机进程与端口之外) / 已经被停过 / 停过但**没停净**(端口让出来了,同组
    // 还有核不上归属、ash 没敢杀的进程还活着 —— 第 2 轮审查发现 2)/ 停过、**一个号都举不
    // 出来但也证明不到停净**(端口超额:没记下的端口谁都没问过 —— 第 3 轮审查发现 1。
    // 这一幕没有活证据,所以它不该卡着启动按钮,但那句话必须还在)。
    const service = (window as unknown as {
      __service?: "live" | "daemon" | "detached" | "stopped" | "leftover" | "unprovable";
    }).__service;
    const sessions = [
      ...(service ? [{
        id: "s-svc", projectId: "p-one", cwd: "/workspace/p-one", shell: "/bin/zsh", name: "服务",
        commandId: "service", startedAt: 4,
        exitCode: service === "live" ? null : 0,
        stoppedByUser: service === "stopped" || service === "leftover" || service === "unprovable",
        groupAlive: service === "live",
        // 启动脚本自报的端口。守护化那一幕里它是唯一还指得到服务的线索 ——
        // 进程归属(ppid / 会话 / pgid)一条都够不着(server/src/service-ports.ts)。
        ports: [8787],
        portsAlive: service === "daemon",
        // 「停了但没停净」的两种形状:leftover = 监听没了、同组那个核不上归属的号还活着
        // (有活证据 ⇒ 还没了结,停止按钮留着让用户再按一次);unprovable = 一个号都举不出来,
        // 但这次停止**证明不到**停净(证据本身不全 ⇒ 不卡按钮,只照实说一句)。
        stop: service === "leftover"
          ? { kind: "unresolved" as const, pids: [4242], why: "端口 8787 已经让出来了，但跟它同组的 pid 4242 还活着" }
          : service === "unprovable"
            ? { kind: "unresolved" as const, pids: [], why: "这次启动打印的本机端口超过 1 个，多出来的没能记下来" }
            : { kind: (service === "stopped" ? "verified" : "none") as const },
        portsTruncated: service === "unprovable",
      }] : []),
      { id: "s-shell", projectId: "p-one", cwd: "/workspace/p-one", shell: "/bin/zsh", name: "第一个项目", commandId: null, startedAt: 1, exitCode: null, stoppedByUser: false, groupAlive: true, ports: [], portsAlive: false, stop: { kind: "none" as const }, portsTruncated: false },
      { id: "s-other", projectId: "p-two", cwd: "/workspace/p-two", shell: "/bin/zsh", name: "别家的 dev server", commandId: "dev", startedAt: 2, exitCode: null, stoppedByUser: false, groupAlive: true, ports: [], portsAlive: false, stop: { kind: "none" as const }, portsTruncated: false },
      ...(slow ? [lateSession] : []),
      ...((window as unknown as { __plainDaemon?: boolean }).__plainDaemon === true ? [plainDaemonSession] : []),
    ];
    if (slow) await new Promise((done) => window.setTimeout(done, 400));
    return reply({ sessions });
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
    service: { command: "npm -w web run dev", restartCommand: null, stopCommand: "docker compose down" },
    commands: COMMANDS,
  }));
  const [notices, setNotices] = useState<string[]>([]);
  const notify = useCallback((message: string) => setNotices((all) => [...all, message]), []);
  return <>
    <main style={{ width: "min(900px, calc(100% - 32px))", margin: "24px auto 60px" }}>
      <ProjectCommandsSettings project={current} onUpdated={setCurrent} notify={notify} />
      {/* 切到一个什么都没跑的项目:用来看「上一个项目的会话事实晚一步回来」会不会赖到它头上。 */}
      <button type="button" onClick={() => setCurrent(project({ service: null, commands: [] }, "p-solo", "另一个项目"))}>切项目</button>
      {/* 没配停止命令的现场:默认停法(进程组 + 端口)得自己立得住,不能要求先配一条才敢认服务开着。 */}
      <button type="button" onClick={() => setCurrent(project({
        service: { command: "npm -w web run dev", restartCommand: null, stopCommand: null },
        commands: COMMANDS,
      }))}>去掉停止命令</button>
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
