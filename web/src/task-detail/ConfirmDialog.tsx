import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Sparkle, Warning, X } from "@phosphor-icons/react";
import { isTopLayer, useDismissable } from "../lib/useDismissable.ts";

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
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  // 登记进那一摞可关闭层，并 portal 到 body。两件事都是为了「后开的在最上面」：
  // ① 确认框常常是从别的全屏层里弹出来的（放大态的 diff、铺开的侧边栏），留在原地会被
  //    那一层的堆叠上下文困住；② 不在这摞层里的话，点确认框会被下面那层读成「点了外面」
  //    而把它连根关掉，Esc 也会被抢走。进了摞就按打开顺序处理：Esc 先关这一个。
  // 遮罩铺满全屏，所以「点外面」只可能是点遮罩本身，仍由下面的 onMouseDown 判定。
  const canClose = !busy || allowCloseWhenBusy;
  useDismissable({ enabled: canClose, containerRef: scrim, onClose });

  // 开着的时候把焦点收进来，关掉时还回去。模态开着而焦点还留在外面那颗触发按钮上的话，
  // Tab 会跑进被遮住的页面，回车更是会再按一次触发按钮而不是这里的确认。children 里
  // 自带 autoFocus 的输入框在这个 effect 之前就拿到焦点了，所以只补没人接管的情况；
  // 落点是对话框本身而不是确认按钮——回车要能确认（见下），但空格不该也能按下危险操作。
  useEffect(() => {
    const previous = document.activeElement;
    if (!dialog.current?.contains(document.activeElement)) dialog.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  // 回车 = 确认。Esc 的对偶，所以同样只有最上面那层吃这一下：对话框里又开了选择器一类的
  // 浮层时，回车归它。
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;
  const canConfirm = !busy && !confirmDisabled;
  useEffect(() => {
    if (!canConfirm) return;
    const confirmOnEnter = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.defaultPrevented) return;
      // 输入法选词、以及带 Shift/Alt 的回车都不是「我要确认」。
      if (event.isComposing || event.keyCode === 229 || event.shiftKey || event.altKey) return;
      if (!isTopLayer(scrim)) return;
      const target = event.target;
      // 焦点漂在对话框外面时直接确认——模态开着，那一下回车不该落回背后的页面。
      if (target instanceof HTMLElement && dialog.current?.contains(target)) {
        // 多行输入里回车是换行，确认让给 Cmd/Ctrl+Enter；按钮、链接、下拉自带回车语义，
        // 抢过来会变成「既取消又确认」。
        const multiline = target instanceof HTMLTextAreaElement || target.isContentEditable;
        if (multiline ? !(event.metaKey || event.ctrlKey) : !!target.closest("button, a, select")) return;
      }
      event.preventDefault();
      event.stopPropagation();
      confirmRef.current();
    };
    document.addEventListener("keydown", confirmOnEnter, true);
    return () => document.removeEventListener("keydown", confirmOnEnter, true);
  }, [canConfirm]);

  return createPortal(
    <div className="task-modal-scrim" ref={scrim} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && canClose) onClose();
    }}>
      <section ref={dialog} tabIndex={-1} className={`task-confirm-dialog${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
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
