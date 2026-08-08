import { useEffect, useRef, useState } from "react";
import type { ProjectView } from "@harness/shared";
import { TerminalWindow, X } from "@phosphor-icons/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api, type TerminalEvent } from "../lib/api.ts";

const TERMINAL_HEIGHT_KEY = "harness-next:terminal-height";
const DEFAULT_HEIGHT = 280;
const MIN_HEIGHT = 170;

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

export function ProjectTerminal({
  project,
  onClose,
  notify,
}: {
  project: ProjectView;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(initialHeight);
  const [status, setStatus] = useState<"starting" | "ready" | "reconnecting" | "ended" | "error">("starting");
  const [cwd, setCwd] = useState(project.repoPath);

  useEffect(() => {
    window.localStorage.setItem(TERMINAL_HEIGHT_KEY, String(height));
  }, [height]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let alive = true;
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
    terminal.loadAddon(fit);
    terminal.open(host);

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
      try { fit.fit(); } catch { /* hidden during teardown */ }
    });
    observer.observe(host);
    requestAnimationFrame(() => {
      try { fit.fit(); terminal.focus(); } catch { /* component was removed */ }
    });

    void api.createTerminalSession(project.id, { cols: terminal.cols, rows: terminal.rows })
      .then((session) => {
        if (!alive) {
          void api.closeTerminalSession(project.id, session.id).catch(() => undefined);
          return;
        }
        sessionId = session.id;
        setCwd(session.cwd);
        source = new EventSource(api.terminalEventsUrl(project.id, session.id));
        source.onopen = () => { if (alive) setStatus("ready"); };
        source.onmessage = (message) => {
          if (!alive) return;
          const event = JSON.parse(message.data) as TerminalEvent;
          if (event.type === "data") terminal.write(event.data);
          else {
            setStatus("ended");
            terminal.write(`\r\n\x1b[90m进程已退出（${event.exitCode}）\x1b[0m\r\n`);
          }
        };
        source.onerror = () => { if (alive) setStatus((current) => current === "ended" ? current : "reconnecting"); };
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
      if (inputTimer !== null) window.clearTimeout(inputTimer);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      if (sessionId) void api.closeTerminalSession(project.id, sessionId).catch(() => undefined);
    };
  }, [notify, project.id]);

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

  const statusLabel = status === "starting" ? "正在启动"
    : status === "ready" ? "已连接"
      : status === "reconnecting" ? "正在重连"
        : status === "ended" ? "已退出"
          : "连接失败";

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
        <span className="project-terminal__tab"><TerminalWindow size={14} weight="fill" /><b>{project.name}</b><small className={`is-${status}`}>{statusLabel}</small></span>
        <code>{cwd}</code>
        <button type="button" aria-label="关闭 CLI" onClick={onClose}><X size={15} /></button>
      </header>
      <div ref={hostRef} className="project-terminal__viewport" aria-label="CLI 终端内容" />
    </section>
  );
}
