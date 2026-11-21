import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CaretDown, CaretUp, Desktop, X } from "@phosphor-icons/react";
import type { ComputerUseFrame } from "@navi/shared/task-runtime";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { attachmentView } from "../task-detail/utils.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import type { TaskRuntime } from "./useTaskRuntime.ts";
import { runtimeApi } from "./runtimeApi.ts";
import { useComputerLivePreview } from "./useComputerLivePreview.ts";
import "./runtime-activity-preview.css";

function PreviewCard({ identity, aspectRatio, children }: {
  identity: string; aspectRatio: number; children: ReactNode;
}) {
  const key = `navi:activity-preview:${identity}`;
  const [visibility, setVisibility] = useState(() => {
    try { return localStorage.getItem(key) || "open"; } catch { return "open"; }
  });
  const containerRef = useRef<HTMLElement>(null);
  const collapsed = visibility === "collapsed";
  const changeVisibility = (next: string) => {
    setVisibility(next);
    try { localStorage.setItem(key, next); } catch {}
  };
  useDismissable({ enabled: visibility !== "closed", containerRef, onClose: () => changeVisibility("closed"), closeOnOutside: false });
  if (visibility === "closed") return null;
  return <aside ref={containerRef} className={`runtime-activity-preview${collapsed ? " is-collapsed" : ""}`} aria-label="电脑操作"
    style={{ "--preview-aspect-ratio": aspectRatio } as CSSProperties}>
    <header>{collapsed && <><Desktop size={14} aria-hidden="true" /><span>电脑操作</span></>}
      <button type="button" aria-label={collapsed ? "展开操作预览" : "收起操作预览"} aria-expanded={!collapsed} onClick={() => changeVisibility(collapsed ? "open" : "collapsed")}>
        {collapsed ? <CaretDown size={14} aria-hidden="true" /> : <CaretUp size={14} aria-hidden="true" />}
      </button>
      <button type="button" aria-label="关闭操作预览" onClick={() => changeVisibility("closed")}><X size={14} aria-hidden="true" /></button>
    </header>
    {!collapsed && children}
  </aside>;
}

function ComputerSurface({ taskId, frame, onEnded, onAspectRatio }: {
  taskId: string; frame: ComputerUseFrame; onEnded: () => void; onAspectRatio: (ratio: number) => void;
}) {
  const live = useComputerLivePreview(taskId, frame);
  const tip = useHoverTip({ placement: "left" });
  const [failed, setFailed] = useState("");
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState("");
  const image = attachmentView(frame.path);
  useEffect(() => { if (live.ended) onEnded(); }, [live.ended, onEnded]);
  if (!image.url || !image.image) return null;
  if (live.ended) return null;
  return <>
    <button type="button" className="runtime-computer-target" aria-label="切到正在操作的应用"
      aria-disabled={!frame.target || activating} {...tip.anchorProps}
      onClick={() => {
        if (!frame.target || activating) return;
        setActivating(true); setError("");
        void runtimeApi.activateComputer(taskId, frame).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
          .finally(() => setActivating(false));
      }}>
      <img src={live.source || image.url} alt={live.source ? "电脑操作实时画面" : "电脑操作的最近截图"} onError={() => setFailed(frame.path)}
        onLoad={({ currentTarget }) => { if (currentTarget.naturalHeight) onAspectRatio(currentTarget.naturalWidth / currentTarget.naturalHeight); }} />
    </button>
    <HoverTip at={tip.at}>{frame.target ? `切到${frame.target.name}` : "未取得目标应用，无法切换"}</HoverTip>
    {!live.source && failed === frame.path && <p role="alert">截图暂时无法加载</p>}
    {live.error && <p role="status">{live.error}
      {live.permission ? <button type="button" onClick={live.requestPermission}>允许实时画面</button>
        : live.error !== "实时画面需要新版 macOS 桌面版" && frame.target && <button type="button" onClick={live.retry}>重连</button>}
    </p>}
    {error && <p role="alert">{error}</p>}
  </>;
}

function ComputerPreview({ taskId, frame }: { taskId: string; frame: ComputerUseFrame }) {
  const [ended, setEnded] = useState(false);
  const [aspectRatio, setAspectRatio] = useState(1.6);
  const onEnded = useCallback(() => setEnded(true), []);
  if (ended) return null;
  return <PreviewCard identity={`${taskId}:${frame.sessionId}:${frame.turnStartedAt}`} aspectRatio={aspectRatio}>
    <ComputerSurface key={`${frame.target?.application}:${frame.target?.windowTitle}`} taskId={taskId} frame={frame} onEnded={onEnded} onAspectRatio={setAspectRatio} />
  </PreviewCard>;
}

export function RuntimeActivityPreview({ runtime }: { runtime: TaskRuntime }) {
  const { computer } = runtime.state;
  return computer ? <ComputerPreview key={`${runtime.taskId}:${computer.sessionId}:${computer.turnStartedAt}`} taskId={runtime.taskId} frame={computer} /> : null;
}
