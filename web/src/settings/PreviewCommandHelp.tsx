import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Question, X } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { useDismissable } from "../lib/useDismissable.ts";
import "./preview-command-help.css";

export function PreviewCommandHelp({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [hasMoreBelow, setHasMoreBelow] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const close = () => setOpen(false);
  useDismissable({ enabled: open, containerRef: scrimRef, restoreFocusRef: triggerRef, onClose: close });

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const background = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== scrimRef.current)
      .map((element) => ({ element, inert: element.inert }));
    for (const { element } of background) element.inert = true;
    return () => {
      for (const { element, inert } of background) element.inert = inert;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [open]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!open || !content) return;
    const updateOverflow = () => setHasMoreBelow(content.scrollTop + content.clientHeight < content.scrollHeight - 1);
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(content);
    for (const section of content.children) observer.observe(section);
    content.addEventListener("scroll", updateOverflow);
    updateOverflow();
    return () => {
      observer.disconnect();
      content.removeEventListener("scroll", updateOverflow);
    };
  }, [open, children]);

  return (
    <>
      <div className="settings-row preview-command-help-row">
        <div><small>查看自动识别、脚本示例和多服务配置说明。</small></div>
        <Button
          ref={triggerRef}
          className="preview-command-help-trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <Question size={16} aria-hidden="true" />配置说明与示例
        </Button>
      </div>
      {open && createPortal(
        <div ref={scrimRef} className="task-modal-scrim" role="presentation" onPointerDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}>
          <section
            className="task-confirm-dialog preview-command-help-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              const focusable = event.currentTarget.querySelectorAll<HTMLElement>('button, [tabindex="0"]');
              const first = focusable[0];
              const last = focusable[focusable.length - 1];
              if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {
                event.preventDefault();
                first?.focus();
              }
            }}
          >
            <header className="task-confirm-header">
              <span><Question size={22} aria-hidden="true" /></span>
              <div><small>配置指南</small><h2 id={titleId}>预览命令说明</h2></div>
              <button type="button" aria-label="关闭预览命令说明" autoFocus onClick={close}><X size={17} /></button>
            </header>
            <p id={descriptionId} className="task-confirm-message">了解自动识别、端口配置和多服务启动方式。</p>
            <div ref={contentRef} className="preview-command-help-content" data-more-below={hasMoreBelow || undefined} tabIndex={0} role="region" aria-label="配置说明内容">{children}</div>
            <footer>
              {hasMoreBelow && <small className="preview-command-help-scroll-hint">向下滚动查看完整说明</small>}
              <Button variant="primary" className="is-primary" onClick={close}>知道了</Button>
            </footer>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
