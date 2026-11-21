import { useState, type ReactNode } from "react";
import { ArrowSquareOut, CaretDown, CaretUp, Desktop, Globe } from "@phosphor-icons/react";
import type { ComputerUseFrame, TaskBrowserState } from "@navi/shared/task-runtime";
import { PreviewableImage } from "../components/ImagePreview.tsx";
import { attachmentView } from "../task-detail/utils.ts";
import { useBrowserFrame } from "./TaskBrowserPane.tsx";
import type { TaskRuntime } from "./useTaskRuntime.ts";
import "./runtime-activity-preview.css";

function PreviewCard({ identity, label, icon, onOpen, children }: {
  identity: string; label: string; icon: ReactNode; onOpen?: () => void; children: ReactNode;
}) {
  const key = `navi:activity-preview:${identity}`;
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(key) === "collapsed"; } catch { return false; }
  });
  const toggle = () => {
    setCollapsed(!collapsed);
    try { localStorage.setItem(key, collapsed ? "open" : "collapsed"); } catch {}
  };
  return <aside className={`runtime-activity-preview${collapsed ? " is-collapsed" : ""}`} aria-label={label}>
    <header>{icon}<span>{label}</span>
      {onOpen && <button type="button" aria-label="展开共享浏览器" onClick={onOpen}><ArrowSquareOut size={14} aria-hidden="true" /></button>}
      <button type="button" aria-label={collapsed ? "展开操作预览" : "收起操作预览"} aria-expanded={!collapsed} onClick={toggle}>
        {collapsed ? <CaretDown size={14} aria-hidden="true" /> : <CaretUp size={14} aria-hidden="true" />}
      </button>
    </header>
    {!collapsed && children}
  </aside>;
}

function BrowserPreviewFrame({ taskId, browser, open }: { taskId: string; browser: TaskBrowserState; open: () => void }) {
  const { frame, error } = useBrowserFrame(taskId, browser);
  return <>
    <button type="button" className="runtime-activity-image" aria-label="查看共享浏览器" onClick={open}>
      {frame ? <img src={frame} alt={browser.title || "共享浏览器画面"} /> : <span>{error || browser.error || "等待页面画面…"}</span>}
    </button>
    {frame && (error || browser.error) && <p role="alert">{error || browser.error}</p>}
  </>;
}

function BrowserPreview({ taskId, browser, open }: { taskId: string; browser: TaskBrowserState; open: () => void }) {
  return <PreviewCard identity={`${taskId}:${browser.id}`} label="浏览器操作" icon={<Globe size={14} aria-hidden="true" />} onOpen={open}>
    <BrowserPreviewFrame taskId={taskId} browser={browser} open={open} />
  </PreviewCard>;
}

function ComputerPreview({ taskId, frame }: { taskId: string; frame: ComputerUseFrame }) {
  const [failed, setFailed] = useState("");
  const image = attachmentView(frame.path);
  if (!image.url || !image.image) return null;
  return <PreviewCard identity={`${taskId}:${frame.sessionId}:${frame.turnStartedAt}`} label="电脑操作" icon={<Desktop size={14} aria-hidden="true" />}>
    <PreviewableImage src={image.url} alt="电脑操作的最近截图" label="电脑操作" onError={() => setFailed(frame.path)} />
    {failed === frame.path && <p role="alert">截图暂时无法加载</p>}
  </PreviewCard>;
}

export function RuntimeActivityPreview({ runtime, activeTabId, openTab }: {
  runtime: TaskRuntime; activeTabId: string | null; openTab: (id: string) => void;
}) {
  const { browser, computer } = runtime.state;
  if (browser && (browser.status === "starting" || browser.status === "ready")) {
    if (activeTabId === "browser") return null;
    return <BrowserPreview key={`${runtime.taskId}:${browser.id}`} taskId={runtime.taskId} browser={browser} open={() => openTab("browser")} />;
  }
  return computer ? <ComputerPreview key={`${runtime.taskId}:${computer.sessionId}:${computer.turnStartedAt}`} taskId={runtime.taskId} frame={computer} /> : null;
}
