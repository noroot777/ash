import { useEffect, useRef, useState } from "react";
import type { BrowserUserAction, TaskBrowserState } from "@ash/shared/task-runtime";
import { ArrowClockwise, ArrowLeft, ArrowRight, CaretDown, CaretUp, X } from "@phosphor-icons/react";
import type { Notify } from "../lib/notify.ts";
import { apiPath, id } from "../lib/apiClient.ts";
import { runtimeApi } from "./runtimeApi.ts";

export function TaskBrowserPane({ taskId, state, onChange, onCollapse, notify }: {
  taskId: string; state: TaskBrowserState; onChange: (next: TaskBrowserState) => void; onCollapse: () => void; notify: Notify;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [frame, setFrame] = useState("");
  const [path, setPath] = useState(state.url);
  const [text, setText] = useState("");
  const [activityOpen, setActivityOpen] = useState(false);
  const objectUrl = useRef("");
  const pending = useRef(Promise.resolve());
  const pendingCount = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const ready = state.status === "ready";
  const controlled = ready && state.control === "user";
  useEffect(() => { setPath(state.url); }, [state.url]);
  useEffect(() => {
    const abort = new AbortController();
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const current = stateRef.current;
        const response = await fetch(apiPath(`/tasks/${id(taskId)}/runtime/browser/frame?id=${id(current.id)}${current.status === "ready" ? "&refresh=1" : ""}`), { signal: abort.signal });
        if (!response.ok) { if (response.status !== 404) throw new Error("共享画面加载失败，请重试"); }
        else {
          const blob = await response.blob();
          if (!canceled) {
            const next = URL.createObjectURL(blob);
            const decoded = new Image();
            decoded.src = next;
            try { await decoded.decode(); }
            catch (reason) { URL.revokeObjectURL(next); throw reason; }
            if (canceled) { URL.revokeObjectURL(next); return; }
            const previous = objectUrl.current;
            objectUrl.current = next;
            setFrame(next);
            if (previous) URL.revokeObjectURL(previous);
          }
        }
      } catch (reason) { if (!canceled) setError(reason instanceof Error ? reason.message : String(reason)); }
      if (!canceled && stateRef.current.status === "ready") timer = setTimeout(() => void poll(), 900);
    };
    if (state.hasFrame || ready) void poll();
    return () => { canceled = true; abort.abort(); clearTimeout(timer); };
  }, [taskId, state.id, ready, state.hasFrame, state.revision]);
  useEffect(() => () => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }, []);
  const act = async (action: BrowserUserAction) => {
    pendingCount.current += 1;
    setBusy(true);
    const next = pending.current.then(async () => {
      setError("");
      try { const result = await runtimeApi.action(taskId, state.id, action); onChange(result.state); }
      catch (reason) { const problem = reason instanceof Error ? reason.message : String(reason); setError(problem); notify(problem); }
      finally { pendingCount.current -= 1; setBusy(pendingCount.current > 0); }
    });
    pending.current = next;
    return next;
  };
  return <aside className="task-browser-pane" aria-label="共享浏览器">
    <header className="task-browser-heading">
      <strong>{state.title || "共享浏览器"}</strong>
      <span>{ready ? controlled ? "你在操作" : "智能体控制" : state.status === "starting" ? "连接中" : "最后画面"}</span>
      {ready && <button disabled={busy} onClick={() => void act({ action: controlled ? "release" : "takeover" })}>{controlled ? "交还" : "接管"}</button>}
      <button aria-label="收起浏览器" onClick={onCollapse}><X aria-hidden="true" size={16} /></button>
    </header>
    <form className="task-browser-navigation" onSubmit={(event) => { event.preventDefault(); void act({ action: "navigate", path }); }}>
      <button type="button" aria-label="后退" disabled={!controlled || busy} onClick={() => void act({ action: "back" })}><ArrowLeft aria-hidden="true" size={16} /></button>
      <button type="button" aria-label="前进" disabled={!controlled || busy} onClick={() => void act({ action: "forward" })}><ArrowRight aria-hidden="true" size={16} /></button>
      <button type="button" aria-label="刷新页面" disabled={!controlled || busy} onClick={() => void act({ action: "reload" })}><ArrowClockwise aria-hidden="true" size={16} /></button>
      <input aria-label="浏览器地址" value={path} readOnly={!controlled} onChange={(event) => setPath(event.target.value)} />
    </form>
    {(error || state.error) && <p className="runtime-error" role="alert">{error || state.error}</p>}
    <div className={`task-browser-viewport ${controlled ? "is-controlled" : ""}`} tabIndex={controlled ? 0 : -1} role="group" aria-label="共享页面画面"
      onKeyDown={(event) => {
        if (!controlled || event.key === "Shift" || event.key === "Control" || event.key === "Alt" || event.key === "Meta") return;
        event.preventDefault();
        void act(event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey ? { action: "type", text: event.key }
          : { action: "press", key: `${event.ctrlKey || event.metaKey ? "ControlOrMeta+" : ""}${event.shiftKey ? "Shift+" : ""}${event.key}` });
      }}>
      {frame ? <img src={frame} alt={state.title || "任务浏览器页面"} draggable={false}
        onClick={(event) => {
          if (!controlled || busy) return;
          event.currentTarget.parentElement?.focus();
          const rect = event.currentTarget.getBoundingClientRect();
          void act({ action: "pointer", x: (event.clientX - rect.left) / rect.width * state.width, y: (event.clientY - rect.top) / rect.height * state.height });
        }} /> : <div className="task-browser-empty">{state.status === "failed" ? "浏览器未连接" : "等待页面画面…"}</div>}
    </div>
    {controlled && <form className="task-browser-input" onSubmit={(event) => { event.preventDefault(); if (text) { void act({ action: "type", text }); setText(""); } }}>
      <input aria-label="向页面输入文字" value={text} onChange={(event) => setText(event.target.value)} placeholder="点选页面输入框，再输入文字" />
      <button disabled={busy || !text}>输入</button>
      <button type="button" disabled={busy} aria-label="页面向上滚动" onClick={() => void act({ action: "scroll", direction: "up" })}><CaretUp aria-hidden="true" size={16} /></button>
      <button type="button" disabled={busy} aria-label="页面向下滚动" onClick={() => void act({ action: "scroll", direction: "down" })}><CaretDown aria-hidden="true" size={16} /></button>
    </form>}
    <footer className="task-browser-footer">
      <span>{state.width} × {state.height}</span>
      {ready && <select aria-label="浏览器尺寸" disabled={!controlled || busy} value={state.width <= 480 ? "mobile" : "desktop"}
        onChange={(event) => void act({ action: "resize", ...(event.target.value === "mobile" ? { width: 390, height: 844 } : { width: 1280, height: 800 }) })}>
        <option value="desktop">桌面</option><option value="mobile">手机</option>
      </select>}
      <button aria-expanded={activityOpen} onClick={() => setActivityOpen(!activityOpen)}>操作记录</button>
      <div className="runtime-strip-spacer" />
      {ready ? <button disabled={busy} onClick={() => void act({ action: "close" })}>关闭浏览器</button>
        : <button disabled={busy} onClick={() => void act({ action: "open" })}>重连</button>}
    </footer>
    {activityOpen && <ol className="task-browser-activity" aria-label="浏览器操作记录">{state.activity.slice().reverse().map((item, index) => <li key={`${item.at}:${index}`}>
      <time>{new Date(item.at).toLocaleTimeString()}</time><span>{item.action}</span>{item.error && <p>{item.error}</p>}
    </li>)}</ol>}
  </aside>;
}
