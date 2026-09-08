// 页面右下角那一句反馈。**两种寿命**，判据在调用点（`Notify` 的 `sticky`）：
//
// · 常规提示两秒多自己走 —— 「已复制」「预览已关闭」这类看一眼就完的话。
// · 常驻那一句等用户自己收 —— 长报错。预览起不来时后端报回来的是一整份东西：认出了
//   哪几个能起服务的东西、每个该怎么起、要前后端一起起该写成什么样。那段文字是拿来
//   照着抄进「设置 → 项目设置 → 预览命令」的，两秒多就走等于没说；用户只知道红了一下，
//   得再点一次「打开预览」才看得见（还是两秒多）。
//
// 拆成独立文件是为了让它**能被单独挂起来测**（scripts/fixtures/preview-error-toast.tsx）——
// WorkspaceShell 整个搬进 headless 里跑不动。
import { useCallback, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import type { Notify } from "../lib/notify.ts";

export interface ToastState {
  message: string;
  /** 不自动消失：只有用户点关闭，或者下一句提示顶掉它。 */
  sticky: boolean;
}

/** 提示的寿命都归这里管：谁在显示、什么时候自己走。 */
export function useToast(): { toast: ToastState | null; notify: Notify; dismiss: () => void } {
  const [toast, setToast] = useState<ToastState | null>(null);
  // 上一句还挂着的自动消失定时器。**必须存下来按掉**：常驻那一句要是被前一句遗留的定时器
  // 扫掉，用户看到的还是「自己消失了」。
  const timer = useRef<number | null>(null);
  const clear = () => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
  };
  const notify = useCallback<Notify>((message, options) => {
    clear();
    const sticky = options?.sticky ?? false;
    setToast({ message, sticky });
    if (sticky) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setToast((current) => current && current.message === message ? null : current);
    }, 2600);
  }, []);
  const dismiss = useCallback(() => { clear(); setToast(null); }, []);
  return { toast, notify, dismiss };
}

export function WorkspaceToast({ toast, onDismiss }: { toast: ToastState | null; onDismiss: () => void }) {
  // 常驻那一句得能点：文字要选得中、抄得走，右上角给一颗关闭。普通提示保持
  // pointer-events: none（样式里给），别挡住底下的界面。
  return (
    <div className={`workspace-toast${toast ? " is-visible" : ""}${toast?.sticky ? " is-sticky" : ""}`} role="status" aria-live="polite">
      <span className="workspace-toast-text" data-testid="workspace-toast-text">{toast?.message}</span>
      {toast?.sticky && (
        <button type="button" className="workspace-toast-close" aria-label="关闭提示" onClick={onDismiss}>
          <X size={12} />
        </button>
      )}
    </div>
  );
}
