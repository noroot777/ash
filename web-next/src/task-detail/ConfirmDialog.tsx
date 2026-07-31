import { useEffect } from "react";
import { Warning } from "@phosphor-icons/react";

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = "取消",
  busy = false,
  danger = false,
  children,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  danger?: boolean;
  children?: React.ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [busy, onClose]);

  return (
    <div className="task-modal-scrim" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className="task-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="task-confirm-title">
        <header>
          <span className={danger ? "is-danger" : ""}><Warning size={16} weight="fill" /></span>
          <h2 id="task-confirm-title">{title}</h2>
        </header>
        <p>{message}</p>
        {children}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>{cancelLabel}</button>
          <button className={danger ? "is-danger" : "is-primary"} type="button" disabled={busy} onClick={onConfirm}>
            {busy ? "处理中…" : confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
