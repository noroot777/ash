import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectView } from "@harness/shared";
import { Plus, TerminalWindow, X } from "@phosphor-icons/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api, type TerminalEvent } from "../lib/api.ts";
import {
  createTerminalTab,
  type ProjectTerminalTab,
  type TerminalStatus,
  withoutTerminalTab,
} from "./terminalTabs.ts";

const TERMINAL_HEIGHT_KEY = "harness-next:terminal-height";
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
  const stored = Number(window.localStorage.getItem(TERMINAL_HEIGHT_KEY));
  return Number.isFinite(stored) ? clampHeight(stored) : DEFAULT_HEIGHT;
}

function clientTabId(): string {
  return window.crypto.randomUUID();
}

function statusLabel(status: TerminalStatus): string {
  return status === "starting" ? "正在启动"
    : status === "ready" ? "已连接"
      : status === "reconnecting" ? "正在重连"
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

    void api.createTerminalSession(project.id, { cols: terminal.cols, rows: terminal.rows })
      .then((session) => {
        if (!alive) {
          void api.closeTerminalSession(project.id, session.id).catch(() => undefined);
          return;
        }
        sessionId = session.id;
        onMeta(tab.id, { cwd: session.cwd });
        source = new EventSource(api.terminalEventsUrl(project.id, session.id));
        source.onopen = () => { if (alive) setStatus("ready"); };
        source.onmessage = (message) => {
          if (!alive) return;
          const event = JSON.parse(message.data) as TerminalEvent;
          if (event.type === "data") terminal.write(event.data);
          else {
            ended = true;
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
      if (sessionId) void api.closeTerminalSession(project.id, sessionId).catch(() => undefined);
    };
  }, [notify, onMeta, project.id, tab.id]);

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
  onClose,
  notify,
}: {
  project: ProjectView;
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
                aria-label={`关闭 ${tab.label}`}
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
