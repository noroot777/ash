import { useEffect, useId, useRef, type ClipboardEventHandler, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PencilSimple, X } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";

export function AnnotationDialog({ children, footer, busy, onClose, onPaste }: {
  children: ReactNode;
  footer: ReactNode;
  busy: boolean;
  onClose: () => void;
  onPaste: ClipboardEventHandler<HTMLElement>;
}) {
  const containerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useDismissable({ enabled: true, containerRef, onClose, closeOnOutside: false });
  useEffect(() => { closeRef.current?.focus(); }, []);
  return createPortal(
    <div className="task-modal-scrim annotation-scrim">
      <section ref={containerRef} className="annotation-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onPaste={onPaste} onKeyDown={(event) => {
        if (event.key !== "Tab" || !event.currentTarget.contains(event.target as Node)) return;
        const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')]
          .filter((element) => element.getClientRects().length > 0 && !element.classList.contains("task-visually-hidden"));
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!focusable.includes(document.activeElement as HTMLElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
          return;
        }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
        <header className="annotation-header">
          <PencilSimple size={22} />
          <div><h2 id={titleId}>截图批注</h2><p>圈出位置，写下希望怎么改</p></div>
          <button ref={closeRef} type="button" disabled={busy} aria-label="关闭截图批注并保留草稿" onClick={onClose}><X size={18} /></button>
        </header>
        {children}
        <footer className="annotation-footer">{footer}</footer>
      </section>
    </div>, document.body,
  );
}
