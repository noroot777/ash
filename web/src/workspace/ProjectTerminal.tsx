import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectView } from "@ash/shared";
import { Plus, TerminalWindow, X } from "@phosphor-icons/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api, type TerminalEvent } from "../lib/api.ts";
import { createClientId } from "../lib/clientId.ts";
import { readRenamedStorage } from "../lib/renamedStorage.ts";
import {
  createAttachTab,
  createTerminalTab,
  type ProjectTerminalTab,
  type TerminalStatus,
  withoutTerminalTab,
} from "./terminalTabs.ts";

const TERMINAL_HEIGHT_KEY = "ash:terminal-height";
const DEFAULT_HEIGHT = 280;
const MIN_HEIGHT = 170;
const MAX_TABS = 8;

function maximumHeight(): number {
  return Math.max(MIN_HEIGHT, Math.min(560, window.innerHeight - 210));
}

function clampHeight(value: number): number {
  return Math.max(MIN_HEIGHT, Math.min(maximumHeight(), Math.round(value)));
}

function initialHeight(): number {
  const stored = Number(readRenamedStorage(TERMINAL_HEIGHT_KEY));
  return Number.isFinite(stored) ? clampHeight(stored) : DEFAULT_HEIGHT;
}

function clientTabId(): string {
  return createClientId();
}

function statusLabel(status: TerminalStatus): string {
  return status === "starting" ? "正在启动"
    : status === "ready" ? "已连接"
      : status === "reconnecting" ? "正在重连"
        : status === "detached" ? "服务运行中（启动脚本已退出）"
          : status === "ended" ? "已退出"
            : "连接失败";
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
  onMeta: (id: string, patch: Partial<Pick<ProjectTerminalTab, "cwd" | "status">>) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      try { fitRef.current?.fit(); terminalRef.current?.focus(); } catch { /* pane was removed */ }
    });
  }, [active]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let alive = true;
    let ended = false;
    let sessionId: string | null = null;
    let source: EventSource | null = null;
    let inputBuffer = "";
    let inputTimer: number | null = null;
    let inputChain = Promise.resolve();
    let resizeTimer: number | null = null;
    let pendingSize: { cols: number; rows: number } | null = null;
    let groupPollTimer: number | null = null;
    let probeAbort: AbortController | null = null;
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.35,
      scrollback: 5000,
      allowTransparency: true,
      theme: {
        background: "#fbfbfc",
        foreground: "#2b2b30",
        cursor: "#5e6ad2",
        cursorAccent: "#fbfbfc",
        selectionBackground: "#dfe2fa",
        black: "#343438",
        red: "#c64a55",
        green: "#168466",
        yellow: "#a46f00",
        blue: "#5260c9",
        magenta: "#8250b6",
        cyan: "#0e879d",
        white: "#e8e8eb",
        brightBlack: "#76767d",
      },
    });
    const fit = new FitAddon();
    terminalRef.current = terminal;
    fitRef.current = fit;
    terminal.loadAddon(fit);
    terminal.open(host);

    const setStatus = (status: TerminalStatus) => onMeta(tab.id, { status });
    const showConnectionError = (reason: unknown) => {
      if (!alive) return;
      setStatus("error");
      const message = reason instanceof Error ? reason.message : String(reason);
      terminal.write(`\r\n\x1b[31mCLI 连接失败：${message}\x1b[0m\r\n`);
      notify(`CLI 连接失败：${message}`);
    };
    const flushInput = () => {
      inputTimer = null;
      if (!sessionId || !inputBuffer) return;
      const data = inputBuffer;
      inputBuffer = "";
      inputChain = inputChain
        .then(() => api.writeTerminalSession(project.id, sessionId!, data))
        .catch(showConnectionError);
    };
    const queueInput = (data: string) => {
      inputBuffer += data;
      if (inputTimer === null) inputTimer = window.setTimeout(flushInput, 12);
    };
    const flushResize = () => {
      resizeTimer = null;
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

    // attach 模式(常用命令的常驻会话):不新建 shell,直接挂上已有会话收发。SSE 从 seq 0
    // 回放服务端缓冲,所以启动早于打开抽屉的输出也能看到。
    const establish: Promise<{ id: string; cwd: string }> = tab.attachSessionId
      ? Promise.resolve({ id: tab.attachSessionId, cwd: tab.cwd })
      : api.createTerminalSession(project.id, { cols: terminal.cols, rows: terminal.rows });
    void establish
      .then((session) => {
        if (!alive) {
          if (!tab.attachSessionId) void api.closeTerminalSession(project.id, session.id).catch(() => undefined);
          return;
        }
        sessionId = session.id;
        onMeta(tab.id, { cwd: session.cwd });
        source = new EventSource(api.terminalEventsUrl(project.id, session.id));
        source.onopen = () => { if (alive && !ended) setStatus("ready"); };
        source.onmessage = (message) => {
          if (!alive) return;
          const event = JSON.parse(message.data) as TerminalEvent;
          if (event.type === "data") {
            terminal.write(event.data);
            return;
          }
          ended = true;
          if (tab.attachSessionId) {
            // 组长退了 ≠ 命令死了(daemonize)。探测循环:立即一次 + 每 5s 一次,**只有
            // 成功拿到事实才下结论**(失败只等下一轮);in-flight 门闩串行化请求 ——
            // 没有它,一次超过 5s 的慢响应会和下一轮并发,停止后旧的「还活着」响应
            // 迟到抵达,把已 ended 的 tab 复活成绿色且 interval 已清、永不自愈
            // (第 6/7/8 轮审查各实锤一角)。ended 是终态,settledEnded 再兜一层。
            let announcedDetached = false;
            let probing = false;
            let settledEnded = false;
            const probe = () => {
              if (probing || settledEnded) return;
              probing = true;
              // 半开连接下 fetch 可能永不 settle,finally 永远不跑,门闩就此卡死、轮询
              // 全部停摆(第 9 轮审查实锤)。每轮给独立超时:abort 强制 Promise settle,
              // 超时视作未知(不下结论),门闩释放后下一轮照常探测;卸载时一并 abort。
              const controller = new AbortController();
              probeAbort = controller;
              const timeout = window.setTimeout(() => controller.abort(), 4000);
              api.listTerminalSessions(project.id, controller.signal).then(({ sessions }) => {
                if (!alive || settledEnded) return;
                const info = sessions.find((item) => item.id === sessionId);
                if (info?.groupAlive) {
                  if (!announcedDetached) {
                    announcedDetached = true;
                    setStatus("detached");
                    terminal.write(`\r\n\x1b[90m启动脚本已退出（${event.exitCode}），服务仍在运行 —— 停止/重启在状态栏\x1b[0m\r\n`);
                  }
                  return;
                }
                settledEnded = true;
                if (groupPollTimer !== null) { window.clearInterval(groupPollTimer); groupPollTimer = null; }
                setStatus("ended");
                terminal.write(announcedDetached
                  ? `\r\n\x1b[90m${info?.stoppedByUser ? "服务已停止" : "服务已退出"}\x1b[0m\r\n`
                  : `\r\n\x1b[90m进程已退出（${event.exitCode}）\x1b[0m\r\n`);
              }).catch(() => undefined) // 拿不到事实就不动,下一轮再试
                .finally(() => {
                  window.clearTimeout(timeout);
                  if (probeAbort === controller) probeAbort = null;
                  probing = false;
                });
            };
            groupPollTimer = window.setInterval(probe, 5000);
            probe();
          } else {
            setStatus("ended");
            terminal.write(`\r\n\x1b[90m进程已退出（${event.exitCode}）\x1b[0m\r\n`);
          }
        };
        source.onerror = () => {
          if (!alive || ended) return;
          onMeta(tab.id, { status: "reconnecting" });
        };
        flushInput();
        queueResize(terminal.cols, terminal.rows);
      })
      .catch(showConnectionError);

    return () => {
      alive = false;
      source?.close();
      observer.disconnect();
      input.dispose();
      resize.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      if (inputTimer !== null) window.clearTimeout(inputTimer);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      if (groupPollTimer !== null) window.clearInterval(groupPollTimer);
      probeAbort?.abort();
      // attach 的会话不归这个 tab 管:关抽屉/收起 tab 只是不看了,服务照跑(停止走状态栏)。
      if (sessionId && !tab.attachSessionId) void api.closeTerminalSession(project.id, sessionId).catch(() => undefined);
    };
  }, [notify, onMeta, project.id, tab.id, tab.attachSessionId, tab.cwd]);

  return (
    <div
      ref={hostRef}
      id={`terminal-panel-${tab.id}`}
      className="project-terminal__viewport"
      role="tabpanel"
      aria-labelledby={`terminal-tab-${tab.id}`}
      aria-label={`${tab.label} 终端内容`}
      hidden={!active}
    />
  );
}

export function ProjectTerminal({
  project,
  focusRequest,
  onClose,
  notify,
}: {
  project: ProjectView;
  /** 状态栏「日志」点过来:打开/切到这条命令会话的 tab。seq 保证同一会话点两次也生效。 */
  focusRequest?: { sessionId: string; seq: number } | null;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const firstTabId = useRef(clientTabId()).current;
  const nextOrdinal = useRef(2);
  const [height, setHeight] = useState(initialHeight);
  const [tabs, setTabs] = useState<ProjectTerminalTab[]>(() => [
    createTerminalTab(firstTabId, 1, project.name, project.repoPath),
  ]);
  const [activeId, setActiveId] = useState(firstTabId);
  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null;

  // 打开抽屉时把常驻命令会话(含刚退出还没回收的)挂成 attach tab,排在交互 shell 前面。
  // 同一条命令可能留着多条历史会话(重启一次多一条),tab 只挂最新那条 —— 全挂会出现
  // 一排重名 tab。不自动激活:用户开抽屉多半是要敲命令,聚焦命令日志走 focusRequest。
  useEffect(() => {
    let alive = true;
    api.listTerminalSessions(project.id).then(({ sessions }) => {
      if (!alive) return;
      const newestPerCommand = new Map<string, (typeof sessions)[number]>();
      for (const session of sessions) {
        if (session.commandId === null) continue;
        const known = newestPerCommand.get(session.commandId);
        if (!known || session.startedAt > known.startedAt) newestPerCommand.set(session.commandId, session);
      }
      setTabs((current) => {
        const knownIds = new Set(current.map((tab) => tab.attachSessionId).filter(Boolean));
        const added = [...newestPerCommand.values()]
          .filter((session) => !knownIds.has(session.id))
          .map((session) => createAttachTab(session.id, session.name, session.cwd));
        return added.length ? [...added, ...current] : current;
      });
    }).catch(() => undefined); // 列表拿不到就只有普通 shell,不值得打断人
    return () => { alive = false; };
  }, [project.id]);

  useEffect(() => {
    if (!focusRequest) return;
    const tabId = `attach:${focusRequest.sessionId}`;
    let alive = true;
    // tab 可能还不存在(刚从状态栏启动的会话),先查一次列表补上再激活。
    api.listTerminalSessions(project.id).then(({ sessions }) => {
      if (!alive) return;
      const session = sessions.find((item) => item.id === focusRequest.sessionId);
      if (!session) return; // 会话已经没了(状态栏的日志按钮只出现在会话还在时,竞态兜底)
      setTabs((current) => current.some((tab) => tab.id === tabId)
        ? current
        : [createAttachTab(session.id, session.name, session.cwd), ...current]);
      setActiveId(tabId);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [focusRequest, project.id]);

  useEffect(() => {
    window.localStorage.setItem(TERMINAL_HEIGHT_KEY, String(height));
  }, [height]);

  const updateTabMeta = useCallback((id: string, patch: Partial<Pick<ProjectTerminalTab, "cwd" | "status">>) => {
    setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, ...patch } : tab));
  }, []);

  const addTab = () => {
    if (tabs.length >= MAX_TABS) {
      notify(`一个抽屉最多打开 ${MAX_TABS} 个 CLI`);
      return;
    }
    const ordinal = nextOrdinal.current++;
    const tab = createTerminalTab(clientTabId(), ordinal, project.name, project.repoPath);
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
  };

  const closeTab = (id: string) => {
    const next = withoutTerminalTab(tabs, activeId, id);
    if (!next.activeId) {
      onClose();
      return;
    }
    setTabs(next.tabs);
    setActiveId(next.activeId);
  };

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    document.body.classList.add("terminal-drawer-resizing");
    const move = (next: PointerEvent) => setHeight(clampHeight(startHeight + startY - next.clientY));
    const finish = () => {
      document.body.classList.remove("terminal-drawer-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };

  return (
    <section className="project-terminal" style={{ height }} aria-label={`${project.name} CLI`}>
      <div
        className="project-terminal__resize"
        role="separator"
        aria-label="调整 CLI 高度，双击恢复默认高度"
        aria-orientation="horizontal"
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={maximumHeight()}
        aria-valuenow={height}
        onPointerDown={beginResize}
        onDoubleClick={() => setHeight(DEFAULT_HEIGHT)}
      />
      <header className="project-terminal__bar">
        <div className="project-terminal__tabs" role="tablist" aria-label="CLI 终端">
          {tabs.map((tab) => (
            <div className={`project-terminal__tab-shell${tab.id === activeId ? " is-active" : ""}`} key={tab.id}>
              <button
                type="button"
                className="project-terminal__tab"
                role="tab"
                id={`terminal-tab-${tab.id}`}
                aria-controls={`terminal-panel-${tab.id}`}
                aria-selected={tab.id === activeId}
                onClick={() => setActiveId(tab.id)}
              >
                <TerminalWindow size={14} weight={tab.id === activeId ? "fill" : "regular"} />
                <b>{tab.label}</b>
                <span className={`project-terminal__status is-${tab.status}`} aria-label={statusLabel(tab.status)} />
              </button>
              <button
                type="button"
                className="project-terminal__tab-close"
                aria-label={tab.attachSessionId ? `收起 ${tab.label}（服务继续跑）` : `关闭 ${tab.label}`}
                onClick={() => closeTab(tab.id)}
              ><X size={12} /></button>
            </div>
          ))}
          <button type="button" className="project-terminal__add" aria-label="新建 CLI" onClick={addTab}>
            <Plus size={15} />
          </button>
        </div>
        <code>{activeTab?.cwd ?? project.repoPath}</code>
        <button type="button" className="project-terminal__drawer-close" aria-label="关闭全部 CLI" onClick={onClose}>
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
          onMeta={updateTabMeta}
        />
      ))}
    </section>
  );
}
