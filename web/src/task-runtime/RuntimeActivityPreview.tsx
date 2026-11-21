import { useState, type ReactNode } from "react";
import { CaretDown, CaretUp, Desktop } from "@phosphor-icons/react";
import type { ComputerUseFrame } from "@navi/shared/task-runtime";
import { PreviewableImage } from "../components/ImagePreview.tsx";
import { attachmentView } from "../task-detail/utils.ts";
import type { TaskRuntime } from "./useTaskRuntime.ts";
import "./runtime-activity-preview.css";

function PreviewCard({ identity, label, icon, children }: {
  identity: string; label: string; icon: ReactNode; children: ReactNode;
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
      <button type="button" aria-label={collapsed ? "展开操作预览" : "收起操作预览"} aria-expanded={!collapsed} onClick={toggle}>
        {collapsed ? <CaretDown size={14} aria-hidden="true" /> : <CaretUp size={14} aria-hidden="true" />}
      </button>
    </header>
    {!collapsed && children}
  </aside>;
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

export function RuntimeActivityPreview({ runtime }: { runtime: TaskRuntime }) {
  const { computer } = runtime.state;
  return computer ? <ComputerPreview key={`${runtime.taskId}:${computer.sessionId}:${computer.turnStartedAt}`} taskId={runtime.taskId} frame={computer} /> : null;
}
