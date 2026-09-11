import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { ArrowsIn, ArrowsOut, Browser, DotsSix, SidebarSimple, X } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { useFloatingPanel } from "./useFloatingPanel.ts";

export function PreviewWorkspaceLayout({ children, hasPreview, drawing, expanded, onExpandedChange, notesOpen, onToggleNotes, onClose, onKeyDown }: {
  children: ReactNode; notesOpen: boolean; onToggleNotes: () => void; onClose: () => void;
  hasPreview: boolean; drawing: boolean; expanded: boolean; onExpandedChange: (expanded: boolean) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const containerRef = useRef<HTMLElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const header = useFloatingPanel<HTMLElement>(hasPreview);
  useDismissable({ enabled: expanded, containerRef, restoreFocusRef: expandRef, closeOnOutside: false, onClose: () => onExpandedChange(false) });
  return <section ref={containerRef} className={`preview-workspace${hasPreview ? " has-preview" : ""}${drawing ? " is-drawing" : ""}${expanded ? " is-expanded" : ""}${notesOpen ? "" : " notes-collapsed"}`}
    aria-label="预览工作区" onKeyDown={onKeyDown}>
    <header ref={header.ref} style={header.style} className={`preview-workspace-header${header.moving ? " is-moving" : ""}`}>
      {hasPreview && <button type="button" className="preview-workspace-drag" aria-label="移动预览操作栏（拖动或方向键）" {...header.handle}><DotsSix size={16} /></button>}
      <Browser size={20} /><div><h2>预览工作区</h2><p>在真实页面上点选、圈画，留下修改意见</p></div>
      <div className="preview-workspace-layout-actions">
        <button type="button" aria-expanded={notesOpen} onClick={onToggleNotes}><SidebarSimple size={16} />{notesOpen ? "收起意见栏" : "展开意见栏"}</button>
        <button ref={expandRef} type="button" aria-pressed={expanded} onClick={() => onExpandedChange(!expanded)}>
          {expanded ? <ArrowsIn size={16} /> : <ArrowsOut size={16} />}{expanded ? "还原预览" : "放大预览"}
        </button>
        <button type="button" aria-label="关闭预览工作区" onClick={onClose}><X size={16} /></button>
      </div>
    </header>
    {children}
  </section>;
}

export function isAnnotationUndo(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; target: EventTarget | null }) {
  if (event.key.toLowerCase() !== "z" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false;
  const target = event.target;
  return !(target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select")));
}
