import { useEffect, useRef } from "react";
import { readRenamedStorage } from "../lib/renamedStorage.ts";

export const WORKSPACE_SIDEBAR_MIN = 220;
export const WORKSPACE_SIDEBAR_MAX = 560;
export const WORKSPACE_SIDEBAR_DEFAULT = 260;
export const WORKSPACE_SIDEBAR_STORAGE_KEY = "ash:sidebar-width";

function clampSidebarWidth(width: number): number {
  return Math.min(WORKSPACE_SIDEBAR_MAX, Math.max(WORKSPACE_SIDEBAR_MIN, width));
}

export function readWorkspaceSidebarWidth(): number {
  const stored = Number(readRenamedStorage(WORKSPACE_SIDEBAR_STORAGE_KEY));
  return Number.isFinite(stored) && stored >= WORKSPACE_SIDEBAR_MIN && stored <= WORKSPACE_SIDEBAR_MAX
    ? stored
    : WORKSPACE_SIDEBAR_DEFAULT;
}

export function WorkspaceResizeHandle({
  width,
  onChange,
}: {
  width: number;
  onChange: (width: number) => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!start.current) return;
      onChange(clampSidebarWidth(start.current.width + event.clientX - start.current.x));
    };
    const stop = () => {
      if (!start.current) return;
      start.current = null;
      document.body.classList.remove("workspace-sidebar-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      document.body.classList.remove("workspace-sidebar-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [onChange]);

  return (
    <div
      className="workspace-sidebar-resize-handle"
      role="separator"
      tabIndex={0}
      aria-label="调整任务树宽度"
      aria-orientation="vertical"
      aria-valuemin={WORKSPACE_SIDEBAR_MIN}
      aria-valuemax={WORKSPACE_SIDEBAR_MAX}
      aria-valuenow={Math.round(width)}
      title="拖动调整任务树宽度；双击重置"
      onMouseDown={(event) => {
        event.preventDefault();
        start.current = { x: event.clientX, width };
        document.body.classList.add("workspace-sidebar-resizing");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onDoubleClick={() => onChange(WORKSPACE_SIDEBAR_DEFAULT)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") onChange(clampSidebarWidth(width - 10));
        else if (event.key === "ArrowRight") onChange(clampSidebarWidth(width + 10));
        else if (event.key === "Home") onChange(WORKSPACE_SIDEBAR_MIN);
        else if (event.key === "End") onChange(WORKSPACE_SIDEBAR_MAX);
        else return;
        event.preventDefault();
      }}
    />
  );
}
