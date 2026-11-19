// 右侧「浏览器」那一格：智能体正在操作的同一个页面（不是另开一个同地址的 iframe）。平时只看；
// 点「接管」后页面能点、能打字、能换尺寸，智能体那边的操作被挡住，「交还」还给它。
// 这一格是宽格（InspectorDescriptor.wide）：选中时右栏跟会话大约五五开。
import { useEffect, useRef, useState } from "react";
import type { BrowserUserAction, TaskBrowserState } from "@navi/shared/task-runtime";
import { ArrowClockwise, ArrowLeft, ArrowRight, CaretDown, CaretUp, DeviceMobile, Monitor } from "@phosphor-icons/react";
import { apiPath, id } from "../lib/apiClient.ts";
import { InspectorHeadActions } from "../inspector/index.ts";
import { InspButton, InspNone } from "../inspector/parts.tsx";
import { runtimeApi } from "./runtimeApi.ts";
import { runtimeErrorText, type BrowserActionTicket, type TaskRuntime } from "./useTaskRuntime.ts";
import "./task-runtime.css";

export function BrowserInspector({ runtime }: { runtime: TaskRuntime }) {
  const browser = runtime.state.browser;
  // 打开 / 重连会换出一个新的浏览器会话，不属于哪个旧会话：走运行环境的动作，完了整份重拉。
  const open = () => void runtime.perform(() => runtimeApi.action(runtime.taskId, undefined, { action: "open" }));
  // 有没有历史会话都显示同一条错误通道：从「服务」那格点「在共享浏览器里查看」被拒，切过来就看得到。
  if (browser) return <TaskBrowserPane key={browser.id} taskId={runtime.taskId} state={browser} error={runtime.error}
    begin={runtime.beginBrowserAction} reopen={open} reopening={runtime.busy} />;
  return (
    <div className="insp-pane">
      <InspNone action={runtime.serviceReady ? <InspButton disabled={runtime.busy} onClick={open}>打开浏览器</InspButton> : undefined}>
        智能体验证页面时，你在这里看到它操作的同一个页面，也可以随时接管。
      </InspNone>
      {runtime.error && <p className="runtime-error" role="alert">{runtime.error}</p>}
    </div>
  );
}

/** 画面轮询自己的失败（加载不出画面）只在这一格显示，下一帧取到就消失。 */
function useBrowserFrame(taskId: string, state: TaskBrowserState) {
  const [frame, setFrame] = useState("");
  const [error, setError] = useState("");
  const objectUrl = useRef("");
  const stateRef = useRef(state);
  stateRef.current = state;
  const ready = state.status === "ready";
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
          if (canceled) return;
          const next = URL.createObjectURL(blob);
          const decoded = new Image();
          decoded.src = next;
          try { await decoded.decode(); }
          catch (reason) { URL.revokeObjectURL(next); throw reason; }
          if (canceled) { URL.revokeObjectURL(next); return; }
          const previous = objectUrl.current;
          objectUrl.current = next;
          setFrame(next);
          setError("");
          if (previous) URL.revokeObjectURL(previous);
        }
      } catch (reason) { if (!canceled) setError(runtimeErrorText(reason)); }
      if (!canceled && stateRef.current.status === "ready") timer = setTimeout(() => void poll(), 900);
    };
    if (state.hasFrame || ready) void poll();
    return () => { canceled = true; abort.abort(); clearTimeout(timer); };
  }, [taskId, state.id, ready, state.hasFrame, state.revision]);
  useEffect(() => () => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }, []);
  return { frame, error };
}

/**
 * `begin`：签发这一格时那次渲染的能力（钉着任务、访问代次、浏览器会话）。动作排队时就绑上它，轮到时
 * 它说不该发了（换了任务或会话）就不发；结果和失败经它落回运行环境那一条通道。
 */
export function TaskBrowserPane({ taskId, state, error, begin, reopen, reopening }: {
  taskId: string; state: TaskBrowserState; error: string; begin: () => BrowserActionTicket | null;
  reopen: () => void; reopening: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState(state.url);
  const [text, setText] = useState("");
  const [activityOpen, setActivityOpen] = useState(false);
  const pending = useRef(Promise.resolve());
  const pendingCount = useRef(0);
  const disposed = useRef(false);
  useEffect(() => { disposed.current = false; return () => { disposed.current = true; }; }, []);
  const { frame, error: frameError } = useBrowserFrame(taskId, state);
  const ready = state.status === "ready";
  const controlled = ready && state.control === "user";
  const mobile = state.width <= 480;
  useEffect(() => { setPath(state.url); }, [state.url]);
  // 动作排成一队按顺序发：连点、连敲不会互相超车。
  // 排队时绑定的是这一次渲染的 begin / taskId / state.id；这一格卸掉（换任务、换会话、切走）后，
  // 还没发出去的一律不发。
  const act = (action: BrowserUserAction) => {
    pendingCount.current += 1;
    setBusy(true);
    const next = pending.current.then(async () => {
      // 票在请求真正发出时领（排队等前一个动作的那段不算），顺序号才对得上发起的先后。
      const ticket = disposed.current ? null : begin();
      try {
        if (!ticket) return;
        try { ticket.write((await runtimeApi.action(taskId, state.id, action)).state); }
        catch (reason) { ticket.fail(reason); }
      } finally { pendingCount.current -= 1; setBusy(pendingCount.current > 0); }
    });
    pending.current = next;
    return next;
  };
  const who = ready ? controlled ? "你在操作" : "智能体在操作" : state.status === "starting" ? "连接中" : "最后画面";
  return (
    <section className={`task-browser-pane${controlled ? " is-controlled" : ""}`} aria-label="共享浏览器">
      <InspectorHeadActions>
        <span className={`task-browser-who${ready && !controlled ? " is-live" : ""}`}>{who}</span>
        {ready && <InspButton size="sm" variant={controlled ? "pri" : "default"} disabled={busy}
          onClick={() => void act({ action: controlled ? "release" : "takeover" })}>{controlled ? "交还" : "接管"}</InspButton>}
      </InspectorHeadActions>
      <form className="task-browser-navigation" onSubmit={(event) => { event.preventDefault(); void act({ action: "navigate", path }); }}>
        <button type="button" aria-label="后退" disabled={!controlled || busy} onClick={() => void act({ action: "back" })}><ArrowLeft aria-hidden="true" size={14} /></button>
        <button type="button" aria-label="前进" disabled={!controlled || busy} onClick={() => void act({ action: "forward" })}><ArrowRight aria-hidden="true" size={14} /></button>
        <button type="button" aria-label="刷新页面" disabled={!controlled || busy} onClick={() => void act({ action: "reload" })}><ArrowClockwise aria-hidden="true" size={14} /></button>
        <input aria-label="浏览器地址" value={path} readOnly={!controlled} spellCheck={false} onChange={(event) => setPath(event.target.value)} />
        <div className="task-browser-size" role="group" aria-label="浏览器尺寸">
          <button type="button" aria-label="桌面尺寸" aria-pressed={!mobile} disabled={!controlled || busy || !mobile}
            onClick={() => void act({ action: "resize", width: 1280, height: 800 })}><Monitor aria-hidden="true" size={14} /></button>
          <button type="button" aria-label="手机尺寸" aria-pressed={mobile} disabled={!controlled || busy || mobile}
            onClick={() => void act({ action: "resize", width: 390, height: 844 })}><DeviceMobile aria-hidden="true" size={14} /></button>
        </div>
      </form>
      {(error || frameError || state.error) && <p className="runtime-error" role="alert">{error || frameError || state.error}</p>}
      <div className={`task-browser-viewport${mobile ? " is-mobile" : ""}`} tabIndex={controlled ? 0 : -1} role="group" aria-label="共享页面画面"
        onKeyDown={(event) => {
          if (!controlled || ["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
          event.preventDefault();
          void act(event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey ? { action: "type", text: event.key }
            : { action: "press", key: `${event.ctrlKey || event.metaKey ? "ControlOrMeta+" : ""}${event.shiftKey ? "Shift+" : ""}${event.key}` });
        }}>
        {frame ? <img src={frame} alt={state.title || "任务浏览器页面"} draggable={false} style={{ aspectRatio: `${state.width} / ${state.height}` }}
          onClick={(event) => {
            if (!controlled || busy) return;
            event.currentTarget.parentElement?.focus();
            const rect = event.currentTarget.getBoundingClientRect();
            void act({ action: "pointer", x: (event.clientX - rect.left) / rect.width * state.width, y: (event.clientY - rect.top) / rect.height * state.height });
          }} /> : <div className="task-browser-empty">{state.status === "failed" ? "浏览器未连接" : "等待页面画面…"}</div>}
      </div>
      {controlled && <form className="task-browser-input" onSubmit={(event) => { event.preventDefault(); if (text) { void act({ action: "type", text }); setText(""); } }}>
        <input aria-label="向页面输入文字" value={text} onChange={(event) => setText(event.target.value)} placeholder="先点页面里的输入框，再在这里打字" />
        <button disabled={busy || !text}>输入</button>
        <button type="button" disabled={busy} aria-label="页面向上滚动" onClick={() => void act({ action: "scroll", direction: "up" })}><CaretUp aria-hidden="true" size={14} /></button>
        <button type="button" disabled={busy} aria-label="页面向下滚动" onClick={() => void act({ action: "scroll", direction: "down" })}><CaretDown aria-hidden="true" size={14} /></button>
      </form>}
      {activityOpen && <ol className="task-browser-activity" aria-label="浏览器操作记录">{state.activity.slice().reverse().map((item, index) => <li key={`${item.at}:${index}`}>
        <time>{new Date(item.at).toLocaleTimeString()}</time><span>{item.action}</span>{item.error && <p>{item.error}</p>}
      </li>)}</ol>}
      <footer className="task-browser-footer">
        <span>{state.width} × {state.height}</span>
        <button type="button" aria-expanded={activityOpen} onClick={() => setActivityOpen(!activityOpen)}>操作记录</button>
        <span className="task-browser-gap" />
        {ready ? <button type="button" disabled={busy} onClick={() => void act({ action: "close" })}>断开</button>
          : <button type="button" disabled={busy || reopening} onClick={reopen}>重连</button>}
      </footer>
    </section>
  );
}
