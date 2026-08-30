import { useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Sparkle, Warning, X } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = "取消",
  busy = false,
  allowCloseWhenBusy = false,
  confirmDisabled = false,
  danger = false,
  className,
  eyebrow,
  icon,
  children,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  allowCloseWhenBusy?: boolean;
  confirmDisabled?: boolean;
  danger?: boolean;
  className?: string;
  eyebrow?: string;
  icon?: ReactNode;
  children?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const scrim = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // 登记进那一摞可关闭层，并 portal 到 body。两件事都是为了「后开的在最上面」：
  // ① 确认框常常是从别的全屏层里弹出来的（放大态的 diff、铺开的侧边栏），留在原地会被
  //    那一层的堆叠上下文困住；② 不在这摞层里的话，点确认框会被下面那层读成「点了外面」
  //    而把它连根关掉，Esc 也会被抢走。进了摞就按打开顺序处理：Esc 先关这一个。
  // 遮罩铺满全屏，所以「点外面」只可能是点遮罩本身，仍由下面的 onMouseDown 判定。
  const canClose = !busy || allowCloseWhenBusy;
  useDismissable({ enabled: canClose, containerRef: scrim, onClose });

  return createPortal(
    <div className="task-modal-scrim" ref={scrim} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && canClose) onClose();
    }}>
      <section className={`task-confirm-dialog${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="task-confirm-header">
          <span className={danger ? "is-danger" : ""}>
            {icon ?? (danger ? <Warning size={19} weight="fill" /> : <Sparkle size={19} weight="duotone" />)}
          </span>
          <div>
            <small>{eyebrow ?? (danger ? "HIGH IMPACT ACTION" : "CONFIRM ACTION")}</small>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button type="button" aria-label={`关闭${title}`} disabled={!canClose} onClick={onClose}><X size={17} /></button>
        </header>
        <p className="task-confirm-message">{message}</p>
        {children}
        <footer>
          <button type="button" disabled={busy && !allowCloseWhenBusy} onClick={onClose}>{cancelLabel}</button>
          <button className={danger ? "is-danger" : "is-primary"} type="button" disabled={busy || confirmDisabled} onClick={onConfirm}>
            {busy ? "处理中…" : confirmLabel}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
