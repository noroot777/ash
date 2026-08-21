import { useRef } from "react";
import { createPortal } from "react-dom";
import { Warning } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = "取消",
  busy = false,
  confirmDisabled = false,
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
  confirmDisabled?: boolean;
  danger?: boolean;
  children?: React.ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const scrim = useRef<HTMLDivElement>(null);
  // 登记进那一摞可关闭层，并 portal 到 body。两件事都是为了「后开的在最上面」：
  // ① 确认框常常是从别的全屏层里弹出来的（放大态的 diff、铺开的侧边栏），留在原地会被
  //    那一层的堆叠上下文困住；② 不在这摞层里的话，点确认框会被下面那层读成「点了外面」
  //    而把它连根关掉，Esc 也会被抢走。进了摞就按打开顺序处理：Esc 先关这一个。
  // 遮罩铺满全屏，所以「点外面」只可能是点遮罩本身，仍由下面的 onMouseDown 判定。
  useDismissable({ enabled: !busy, containerRef: scrim, onClose });

  return createPortal(
    <div className="task-modal-scrim" ref={scrim} role="presentation" onMouseDown={(event) => {
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
          <button className={danger ? "is-danger" : "is-primary"} type="button" disabled={busy || confirmDisabled} onClick={onConfirm}>
            {busy ? "处理中…" : confirmLabel}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
