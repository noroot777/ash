import { useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Question, X } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { useDismissable } from "../lib/useDismissable.ts";
import "./preview-command-help.css";

export function PreviewCommandHelp({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  useDismissable({ enabled: open, containerRef: dialogRef, restoreFocusRef: triggerRef, onClose: close });

  return (
    <>
      <div className="settings-row preview-command-help-row">
        <div><small>留空时自动识别；有多个启动项时，需要手动指定。</small></div>
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
        <div className="task-modal-scrim">
          <section
            ref={dialogRef}
            className="task-confirm-dialog preview-command-help-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              const focusable = event.currentTarget.querySelectorAll<HTMLElement>('button, [tabindex="0"]');
              const first = focusable[0];
              const last = focusable[focusable.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
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
            <div className="preview-command-help-content" tabIndex={0} role="region" aria-label="配置说明内容">{children}</div>
            <footer><Button variant="primary" className="is-primary" onClick={close}>知道了</Button></footer>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
