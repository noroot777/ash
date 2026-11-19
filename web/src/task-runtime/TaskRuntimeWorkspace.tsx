import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TaskRuntimeState } from "@ash/shared/task-runtime";
import type { Notify } from "../lib/notify.ts";
import { id, request } from "../lib/apiClient.ts";
import { runtimeApi } from "./runtimeApi.ts";
import { TaskBrowserPane } from "./TaskBrowserPane.tsx";
import "./task-runtime.css";

const empty: TaskRuntimeState = { service: null, browser: null };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function TaskRuntimeWorkspace({ taskId, notify, children }: { taskId: string; notify: Notify; children: ReactNode }) {
  const [state, setState] = useState<TaskRuntimeState>(empty);
  const [expanded, setExpanded] = useState(() => localStorage.getItem(`ash-browser-pane:${taskId}`) !== "closed");
  const [logs, setLogs] = useState(false);
  const [log, setLog] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;
  const refresh = async () => {
    const next = await runtimeApi.state(taskId);
    if (mounted.current) { setState(next); setError(""); }
    return next;
  };
  useEffect(() => {
    mounted.current = true;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(); }
      catch (reason) { if (!canceled && (stateRef.current.browser || stateRef.current.service)) setError(errorText(reason)); }
      if (!canceled) timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => { canceled = true; mounted.current = false; clearTimeout(timer); };
  }, [taskId]);
  useEffect(() => {
    if (!logs) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await request<{ text: string }>(`/tasks/${id(taskId)}/preview?log=1`);
        if (!canceled) setLog(result.text);
      } catch (reason) { if (!canceled) setLog(errorText(reason)); }
      if (!canceled) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { canceled = true; clearTimeout(timer); };
  }, [taskId, logs]);
  const perform = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try { await action(); await refresh(); }
    catch (reason) { const text = errorText(reason); setError(text); notify(text); await refresh().catch(() => {}); }
    finally { if (mounted.current) setBusy(false); }
  };
  const toggleBrowser = (next: boolean) => {
    localStorage.setItem(`ash-browser-pane:${taskId}`, next ? "open" : "closed");
    setExpanded(next);
  };
  const service = state.service;
  const browser = state.browser;
  const primary = service?.services?.[0];
  const ready = !!service?.url && !service.starting;
  const status = service?.starting ? "启动中" : ready ? "运行中" : primary?.status === "failed" ? "启动失败" : "已停止";
  return <div className="task-runtime-workspace">
    {(service || browser) && <div className="task-runtime-strip" aria-label="任务运行环境">
      {service && <>
        <span className={`runtime-status ${ready ? "is-ready" : service.starting ? "is-starting" : ""}`} aria-label={status} />
        <strong>{primary?.name || "Demo"}</strong>
        <span className="runtime-port">{ready ? service.port : status}</span>
        {ready && <a href={service.url!} target="_blank" rel="noreferrer">打开</a>}
        <button aria-expanded={logs} onClick={() => setLogs(!logs)}>日志</button>
        {service.running ? <button disabled={busy} onClick={() => void perform(() => runtimeApi.stop(taskId))}>停止</button>
          : service.command && <button disabled={busy} onClick={() => void perform(() => runtimeApi.start(taskId, service.command!))}>重启</button>}
      </>}
      <div className="runtime-strip-spacer" />
      {(ready || browser) && <button aria-expanded={expanded && !!browser} onClick={() => {
        toggleBrowser(true);
        if (browser?.status !== "ready" && ready) void perform(() => runtimeApi.action(taskId, undefined, { action: "open" }));
      }}>浏览器{browser?.status === "ready" && browser.control === "user" ? " · 已接管" : ""}</button>}
    </div>}
    {error && <div className="runtime-error" role="alert">{error}</div>}
    {logs && <div className="runtime-log" role="region" aria-label="服务日志"><pre>{log || "等待服务输出…"}</pre></div>}
    <div className={`task-runtime-content ${expanded && browser ? "has-browser" : ""}`}>
      <div className="task-runtime-main">{children}</div>
      {expanded && browser && <TaskBrowserPane taskId={taskId} state={browser}
        onChange={(next) => setState((previous) => ({ ...previous, browser: next }))}
        onCollapse={() => toggleBrowser(false)} notify={notify} />}
    </div>
  </div>;
}
