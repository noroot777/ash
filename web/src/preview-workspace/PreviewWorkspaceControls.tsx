import { useId, type ReactNode } from "react";
import { DotsSix, CaretDown, CaretUp } from "@phosphor-icons/react";
import { useFloatingPanel } from "./useFloatingPanel.ts";

export function PreviewWorkspaceControls({ floating, open, onOpenChange, mode, notice, children }: {
  floating: boolean; open: boolean; onOpenChange: (open: boolean) => void; mode: string; notice?: ReactNode; children: ReactNode;
}) {
  const panel = useFloatingPanel<HTMLDivElement>(floating);
  const contentId = useId();
  return <div ref={panel.ref} style={panel.style} className={`preview-workspace-controls${panel.moving ? " is-moving" : ""}`}>
    {floating && <div className="preview-workspace-controls-heading">
      <button type="button" className="preview-workspace-drag" aria-label="移动标注工具（拖动或方向键）" {...panel.handle}><DotsSix size={16} />移动</button>
      <span>{mode} · 标注工具</span>
      <button type="button" aria-controls={contentId} aria-expanded={open} onClick={() => onOpenChange(!open)}>
        {open ? <CaretDown size={14} /> : <CaretUp size={14} />}{open ? "收起标注工具" : "展开标注工具"}
      </button>
    </div>}
    <div id={contentId} hidden={floating && !open}>{children}</div>
    {notice}
  </div>;
}
