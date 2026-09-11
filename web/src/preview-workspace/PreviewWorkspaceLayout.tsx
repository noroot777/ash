import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { ArrowsIn, ArrowsOut, Browser, SidebarSimple, X } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";

export function PreviewWorkspaceLayout({ children, expanded, onExpandedChange, notesOpen, onToggleNotes, onClose, onKeyDown }: {
  children: ReactNode; notesOpen: boolean; onToggleNotes: () => void; onClose: () => void;
  expanded: boolean; onExpandedChange: (expanded: boolean) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const containerRef = useRef<HTMLElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  useDismissable({ enabled: expanded, containerRef, restoreFocusRef: expandRef, closeOnOutside: false, onClose: () => onExpandedChange(false) });
  return <section ref={containerRef} className={`preview-workspace${expanded ? " is-expanded" : ""}${notesOpen ? "" : " notes-collapsed"}`}
    aria-label="预览工作区" onKeyDown={onKeyDown}>
    <header className="preview-workspace-header">
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
