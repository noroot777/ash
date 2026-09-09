import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

const nativeFetch = window.fetch.bind(window);
const stats = { requests: 0, completed: 0, held: false };
let failNext = false;
let holdNext: "normal" | "stale" | null = null;
let release: (() => void) | undefined;
const changed = () => window.dispatchEvent(new Event("branch-probe"));
const polls = new Map<number, () => void>();
if (new URLSearchParams(location.search).get("clock") === "manual") {
  const timers: Window = window;
  const interval = timers.setInterval.bind(timers);
  const clear = timers.clearInterval.bind(timers);
  let nextTimer = -1;
  timers.setInterval = (handler, delay, ...args) => {
    if (delay !== 15_000 || typeof handler !== "function") return interval(handler, delay, ...args);
    const id = nextTimer--;
    polls.set(id, () => handler(...args));
    return id;
  };
  timers.clearInterval = id => { if (id !== undefined && polls.delete(id)) return; clear(id); };
}
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!/\/branch-plan$/.test(url)) return nativeFetch(input, init);
  stats.requests++;
  changed();
  let response: Response;
  if (failNext) {
    failNext = false;
    response = new Response(JSON.stringify({ error: "测试读取失败" }), { status: 503 });
  } else if (holdNext) {
    const stale = holdNext === "stale";
    holdNext = null;
    const result = await (await nativeFetch(input, init)).json();
    if (stale) result.task.blocker = "过期响应不应覆盖新结果";
    await new Promise<void>(resolve => { release = resolve; stats.held = true; changed(); });
    response = new Response(JSON.stringify(result));
    stats.held = false;
  } else response = await nativeFetch(input, init);
  stats.completed++;
  changed();
  return response;
};

export function BranchPlanProbe({ onUpdate, onDialogUpdate, mounted, onToggle }: {
  onUpdate: () => void; onDialogUpdate: () => Promise<void>; mounted: boolean; onToggle: () => void;
}) {
  const [, render] = useState(0);
  const [dialog, setDialog] = useState<Element | null>(null);
  const [updateOnDialog, setUpdateOnDialog] = useState(false);
  useEffect(() => {
    const observe = () => setDialog(document.querySelector('[role="dialog"]'));
    const observer = new MutationObserver(observe);
    observer.observe(document.body, { childList: true, subtree: true });
    observe();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (dialog && updateOnDialog) { setUpdateOnDialog(false); void onDialogUpdate(); }
  }, [dialog, updateOnDialog, onDialogUpdate]);
  useEffect(() => {
    const update = () => render(n => n + 1);
    window.addEventListener("branch-probe", update);
    return () => window.removeEventListener("branch-probe", update);
  }, []);
  return <section aria-label="请求探针">
    <output aria-label="依赖请求次数">{stats.requests}</output>
    <output aria-label="依赖响应次数">{stats.completed}</output>
    <output aria-label="延迟状态">{stats.held ? "已挂起" : "无挂起"}</output>
    <button onClick={onUpdate}>模拟任务更新</button>
    <button onClick={() => setUpdateOnDialog(true)}>确认框打开时更新标签</button>
    <button onClick={() => { for (const poll of polls.values()) poll(); }}>轮询一次</button>
    <button onClick={onToggle}>{mounted ? "卸载验收界面" : "恢复验收界面"}</button>
    <button onClick={() => { failNext = true; }}>下次依赖请求失败</button>
    <button onClick={() => { holdNext = "stale"; }}>延迟下次依赖响应</button>
    <button onClick={() => { holdNext = "normal"; }}>延迟正常依赖响应</button>
    <button onClick={() => { release?.(); release = undefined; }}>释放旧响应</button>
    {dialog && stats.held && createPortal(<button onClick={() => { release?.(); release = undefined; }}>完成测试依赖响应</button>, dialog)}
  </section>;
}
