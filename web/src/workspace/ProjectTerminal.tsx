import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectView } from "@ash/shared";
import { X } from "@phosphor-icons/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api, type TerminalEvent } from "../lib/api.ts";
import { readRenamedStorage } from "../lib/renamedStorage.ts";
import type { ProjectTerminalTab } from "./terminalTabs.ts";
import type { TerminalDock } from "./useTerminalDock.ts";

const TERMINAL_HEIGHT_KEY = "ash:terminal-height";
const DEFAULT_HEIGHT = 280;
const MIN_HEIGHT = 170;
const MAX_HEIGHT = 560;

function maximumHeight(viewportHeight: number = window.innerHeight): number {
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, viewportHeight - 210));
}

/** 拖拽用:按**当前窗口**能给的高度夹。 */
function clampHeight(value: number, viewportHeight?: number): number {
  return Math.max(MIN_HEIGHT, Math.min(maximumHeight(viewportHeight), Math.round(value)));
}

/** 偏好用:只按绝对上下限夹,**不看窗口** —— 看了就等于「窗口临时矮」把偏好永久改小。 */
function preferredHeight(value: number): number {
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(value)));
}

function initialHeight(): number {
  // 没存过时 readRenamedStorage 给的是 null,Number(null) = 0 —— 0 也是有限数,照单全收
  // 就等于每个新用户第一次开终端都只得到 MIN_HEIGHT 那一条缝,而不是 DEFAULT_HEIGHT。
  const stored = Number(readRenamedStorage(TERMINAL_HEIGHT_KEY));
  return Number.isFinite(stored) && stored > 0 ? preferredHeight(stored) : DEFAULT_HEIGHT;
}

function TerminalPane({
  active,
  project,
  tab,
  notify,
  onMeta,
}: {
  active: boolean;
  project: ProjectView;
  tab: ProjectTerminalTab;
  notify: (message: string) => void;
  onMeta: (id: string, patch: Partial<Pick<ProjectTerminalTab, "cwd" | "status" | "sessionId">>) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // 已经有会话的 tab(attach 来的,或自己建完回填了 sessionId)一挂上就能收发;只有全新的
  // shell tab 要等 create 完才有 id。流 effect 等这个。
  const sessionIdRef = useRef<string | null>(tab.attachSessionId ?? tab.sessionId ?? null);
  const [establishedId, setEstablishedId] = useState<string | null>(tab.attachSessionId ?? tab.sessionId ?? null);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  // 每条 SSE 连接生命周期内,每种说明只写一次(重连 reset 后重置,replay 末尾补写)。
  const announcedRef = useRef({ detached: false, ended: false });
  const prevStatusRef = useRef(tab.status);

  // attach tab 的正文说明:按当前会话事实追加一行灰字,措辞按 tab 身份分两套(命令日志
  // 说「服务」,恢复的交互 shell 说「进程」)。触发点有二 —— 状态转变(集中轮询推进
  // detached/ended)和 SSE replay 到 exit(重连后补写,否则 reset 把上一条连接写的说明
  // 冲掉了)。
  const announce = useCallback(() => {
    const terminal = terminalRef.current;
    const current = tabRef.current;
    if (!terminal || !current.attachSessionId) return;
    const flags = announcedRef.current;
    const isCommand = current.kind === "command";
    if (current.status === "detached" && !flags.detached) {
      flags.detached = true;
      terminal.write(isCommand
        ? `\r\n\x1b[90m启动脚本已退出（${current.exitCode ?? 0}），服务仍在运行 —— 停止/重启在状态栏\x1b[0m\r\n`
        : `\r\n\x1b[90mshell 已退出（${current.exitCode ?? 0}），它启动的后台进程仍在运行\x1b[0m\r\n`);
    } else if (current.status === "ended" && !flags.ended) {
      flags.ended = true;
      terminal.write(!isCommand
        ? `\r\n\x1b[90m进程已退出（${current.exitCode ?? 0}）\x1b[0m\r\n`
        : current.stoppedByUser
          ? "\r\n\x1b[90m服务已停止\x1b[0m\r\n"
          : flags.detached
            ? "\r\n\x1b[90m服务已退出\x1b[0m\r\n"
            : `\r\n\x1b[90m进程已退出（${current.exitCode ?? 0}）\x1b[0m\r\n`);
    }
  }, []);

  useEffect(() => {
    if (prevStatusRef.current === tab.status) return;
    prevStatusRef.current = tab.status;
    announce();
  }, [tab.status, announce]);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      try { fitRef.current?.fit(); terminalRef.current?.focus(); } catch { /* pane was removed */ }
    });
  }, [active]);

  // 基座:xterm 实例、输入/резize 通道、shell 会话的创建与关闭。日志流不在这里 ——
  // 它跟随 active(见下一个 effect),隐藏 tab 不占长连接。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let alive = true;
    let inputBuffer = "";
    let inputTimer: number | null = null;
    let inputChain = Promise.resolve();
    let resizeTimer: number | null = null;
    let pendingSize: { cols: number; rows: number } | null = null;
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.35,
      scrollback: 5000,
      allowTransparency: true,
      // 底部坞是深色的(terminal.css),xterm 的调色板跟着走:浅色那套落在 #17181d 上
      // 只剩一团糊。色值取自设计稿 demo(docs/demos/project-command-center/shared.css)。
      theme: {
        background: "#17181d",
        foreground: "#c9cbd6",
        cursor: "#8f9aff",
        cursorAccent: "#17181d",
        selectionBackground: "#3a3d55",
        black: "#2b2c34",
        red: "#ef7a86",
        green: "#58c99a",
        yellow: "#e0b356",
        blue: "#7f9cf5",
        magenta: "#c08bf0",
        cyan: "#5ac8d8",
        white: "#c9cbd6",
        brightBlack: "#71737f",
        brightWhite: "#ecedf2",
      },
    });
    const fit = new FitAddon();
    terminalRef.current = terminal;
    fitRef.current = fit;
    terminal.loadAddon(fit);
    terminal.open(host);

    const showConnectionError = (reason: unknown) => {
      if (!alive) return;
      onMeta(tab.id, { status: "error" });
      const message = reason instanceof Error ? reason.message : String(reason);
      terminal.write(`\r\n\x1b[31mCLI 连接失败：${message}\x1b[0m\r\n`);
      notify(`CLI 连接失败：${message}`);
    };
    const flushInput = () => {
      inputTimer = null;
      const sessionId = sessionIdRef.current;
      if (!sessionId || !inputBuffer) return;
      const data = inputBuffer;
      inputBuffer = "";
      inputChain = inputChain
        .then(() => api.writeTerminalSession(project.id, sessionId, data))
        .catch(showConnectionError);
    };
    const queueInput = (data: string) => {
      inputBuffer += data;
      if (inputTimer === null) inputTimer = window.setTimeout(flushInput, 12);
    };
    const flushResize = () => {
      resizeTimer = null;
      const sessionId = sessionIdRef.current;
      if (!sessionId || !pendingSize) return;
      const size = pendingSize;
      pendingSize = null;
      void api.resizeTerminalSession(project.id, sessionId, size).catch(showConnectionError);
    };
    const queueResize = (cols: number, rows: number) => {
      pendingSize = { cols, rows };
      if (resizeTimer === null) resizeTimer = window.setTimeout(flushResize, 80);
    };

    const input = terminal.onData(queueInput);
    const resize = terminal.onResize(({ cols, rows }) => queueResize(cols, rows));
    const observer = new ResizeObserver(() => {
      if (host.offsetParent === null) return;
      try { fit.fit(); } catch { /* hidden during teardown */ }
    });
    observer.observe(host);
    requestAnimationFrame(() => {
      if (host.offsetParent === null) return;
      try { fit.fit(); terminal.focus(); } catch { /* component was removed */ }
    });

    // 只有「还没有任何会话」的 tab 才新建。光看 attachSessionId 不够 —— 前端自己建的 shell
    // 把会话 id 回填在 sessionId 上,这种 tab 要是又走一遍创建(挂到别的项目、或基座 effect
    // 因依赖变化重跑),就会平白多起一个 shell(第 1 轮逻辑审查:切项目时 create 了两次)。
    if (!tab.attachSessionId && !tab.sessionId) {
      void api.createTerminalSession(project.id, { cols: terminal.cols, rows: terminal.rows })
        .then((session) => {
          if (!alive) {
            // 会话建成前 tab 就没了(关抽屉/StrictMode 重挂):还没人看过一眼,直接收掉,
            // 不留一个空 shell 等下次恢复。
            void api.closeTerminalSession(project.id, session.id).catch(() => undefined);
            return;
          }
          sessionIdRef.current = session.id;
          // sessionId 回填到 tab 上:交互 shell 的 ✕(closeTab)靠它结束会话。
          onMeta(tab.id, { cwd: session.cwd, sessionId: session.id });
          setEstablishedId(session.id);
          flushInput();
          queueResize(terminal.cols, terminal.rows);
        })
        .catch(showConnectionError);
    }

    return () => {
      alive = false;
      observer.disconnect();
      input.dispose();
      resize.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      if (inputTimer !== null) window.clearTimeout(inputTimer);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      // 会话是持久的(VSCode 语义):unmount 只发生在关抽屉/收起 tab/切项目,这些都不杀
      // shell —— 重开抽屉从会话列表原样恢复。结束会话统一走 closeTab 的 DELETE。
    };
  }, [notify, onMeta, project.id, tab.id, tab.attachSessionId]);

  // 日志流:只有激活 tab 保持 SSE。每个隐藏 tab 一条常驻长连接会把 Chrome 的同源
  // 连接池(HTTP/1.1 同主机 6 条)占满,停止/重启和一切状态轮询全部 pending,控制面
  // 冻结(第 1 轮审查实锤:6 条活命令即可复现)。切走即断,切回 reset 后从 seq 0
  // 重放服务端缓冲 —— 日志不丢,连接数恒为 1。
  useEffect(() => {
    if (!active || !establishedId) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    let alive = true;
    let ended = false;
    terminal.reset();
    announcedRef.current = { detached: false, ended: false };
    const source = new EventSource(api.terminalEventsUrl(project.id, establishedId));
    // attach tab 的状态点表达会话/服务事实,由集中轮询驱动,连接事件不碰它。
    source.onopen = () => { if (alive && !ended && !tab.attachSessionId) onMeta(tab.id, { status: "ready" }); };
    source.onmessage = (message) => {
      if (!alive) return;
      const event = JSON.parse(message.data) as TerminalEvent;
      if (event.type === "data") {
        terminal.write(event.data);
        return;
      }
      ended = true;
      if (tab.attachSessionId) {
        // 组长退了 ≠ 命令死了(daemonize),结论归集中轮询;这里只按已知事实补写说明
        // (重放场景:上一条连接写过的说明被 reset 冲掉了,exit 是重放的收尾信号)。
        announce();
      } else {
        onMeta(tab.id, { status: "ended" });
        terminal.write(`\r\n\x1b[90m进程已退出（${event.exitCode}）\x1b[0m\r\n`);
      }
    };
    source.onerror = () => {
      if (!alive || ended || tab.attachSessionId) return;
      onMeta(tab.id, { status: "reconnecting" });
    };
    return () => {
      alive = false;
      source.close();
    };
  }, [active, establishedId, project.id, tab.id, tab.attachSessionId, onMeta, announce]);

  return (
    <div
      ref={hostRef}
      id={`terminal-panel-${tab.id}`}
      className="project-terminal__viewport"
      // 不用 tabpanel:tab 条搬到状态栏后,它在抽屉收起时照样在,tab/tabpanel 那套配对
      // 就凑不齐了(收着的时候根本没有 panel)。一块有名字的区域,说清楚是谁的现场即可。
      role="group"
      aria-label={`${tab.label} 终端内容`}
      hidden={!active}
    />
  );
}

export function ProjectTerminal({
  project,
  dock,
  notify,
}: {
  project: ProjectView;
  /** 开着哪几个终端、哪个在前台,统一由 WorkspaceShell 那份账本(useTerminalDock)说了算 —— 
      tab 条本身摆在状态栏上,抽屉这里只负责现场。 */
  dock: TerminalDock;
  notify: (message: string) => void;
}) {
  const { tabs, activeId, activeTab } = dock;
  // height = 用户挑的那个高度(偏好),appliedHeight = 按当前窗口夹过的实际高度。
  // 底部坞横着占一整行,高度不跟着窗口收就会把上面的工作区整个挤没(实测:560 的终端
  // + 620 高的窗口 = 侧栏和主区只剩 34px);但**夹只发生在渲染这一侧** —— 偏好既不在
  // 读取时按窗口夹、也不在挂载/窗口变化时回写,否则「在矮窗口里开一次终端」就等于
  // 把他存的 560 永久改成 410,窗口拉回来也回不去了(第 1 轮审查实锤)。
  const [height, setHeight] = useState(initialHeight);
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const appliedHeight = clampHeight(height, viewportHeight);
  // 落盘只由**用户亲手调**触发(拖拽收手、双击复位),不挂 effect 跟着 state 走。
  const rememberHeight = useCallback((value: number) => {
    const next = preferredHeight(value);
    setHeight(next);
    window.localStorage.setItem(TERMINAL_HEIGHT_KEY, String(next));
  }, []);

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = appliedHeight;
    document.body.classList.add("terminal-drawer-resizing");
    // 拖的过程中只动 state(跟手),收手时才落盘 —— 每个 pointermove 都写一次
    // localStorage 是同步 IO,没必要。
    let latest = startHeight;
    const move = (next: PointerEvent) => {
      latest = clampHeight(startHeight + startY - next.clientY, viewportHeight);
      setHeight(latest);
    };
    const finish = () => {
      document.body.classList.remove("terminal-drawer-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      rememberHeight(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };

  return (
    <section className="project-terminal" style={{ height: appliedHeight }} aria-label={`${project.name} CLI`}>
      <div
        className="project-terminal__resize"
        role="separator"
        aria-label="调整 CLI 高度，双击恢复默认高度"
        aria-orientation="horizontal"
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={maximumHeight(viewportHeight)}
        aria-valuenow={appliedHeight}
        onPointerDown={beginResize}
        onDoubleClick={() => rememberHeight(DEFAULT_HEIGHT)}
      />
      <header className="project-terminal__bar">
        <code>{activeTab?.cwd ?? project.repoPath}</code>
        <button type="button" className="project-terminal__drawer-close" aria-label="收起终端（shell 与服务继续跑）" onClick={dock.hide}>
          <X size={15} />
        </button>
      </header>
      {tabs.map((tab) => (
        <TerminalPane
          key={tab.id}
          tab={tab}
          project={project}
          active={tab.id === activeId}
          notify={notify}
          onMeta={dock.setMeta}
        />
      ))}
    </section>
  );
}
