// 页面右下角那几句反馈。**两条互不打断的通道**，判据在调用点（`Notify` 的 `sticky`）：
//
// · 常规提示两秒多自己走 —— 「已复制」「预览已关闭」这类看一眼就完的话。
// · 常驻那一句等用户自己收 —— 长报错。预览起不来时后端报回来的是一整份东西：认出了
//   哪几个能起服务的东西、每个该怎么起、要前后端一起起该写成什么样。那段文字是拿来
//   照着抄进「设置 → 项目设置 → 预览命令」的，两秒多就走等于没说；用户只知道红了一下，
//   得再点一次「打开预览」才看得见（还是两秒多）。
//
// **两条通道必须分开放**，这是第一版栽过的坑：只有一个槽位时，常驻那句会被随便哪条后续
// 普通提示顶掉，然后那条普通提示的定时器把整个 toast 清空 —— 用户一次关闭都没点，要照抄
// 的命令就没了。而 `notify` 是 WorkspaceShell 全局共享的：项目列表读取失败、复制反馈、
// 分组创建……任何一处异步动作都可能在他读那段报错时插进来。所以常驻那句自己占一个槽，
// 只有用户点关闭、或者**下一次同样常驻的报错**才动得了它；普通提示照旧在它下面来去。
//
// 拆成独立文件是为了让它**能被单独挂起来测**（scripts/fixtures/preview-error-toast.tsx）——
// WorkspaceShell 整个搬进 headless 里跑不动。
//
// 那段话里的「设置 → 项目设置 → 预览 → 自定义脚本」是一条**能点的路**（SettingsPathText）：
// 用户读到它的时候正卡着，没道理让他自己退出任务、翻侧栏、再一张张卡找过去。没接跳转的
// 调用方（测试夹具之类）照旧渲染成普通文字。
import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { SettingsPathText } from "../settings/SettingsPathText.tsx";
import type { SettingsSection } from "../settings/sections.ts";
import type { Notify } from "../lib/notify.ts";

export interface ToastState {
  message: string;
}

/** 此刻挂着的两句话：常驻那一句（等用户收）和普通那一句（自己走）。 */
export interface ToastSlots {
  pinned: ToastState | null;
  transient: ToastState | null;
}

/** 提示的寿命都归这里管：谁在显示、什么时候自己走。 */
export function useToast(): { toasts: ToastSlots; notify: Notify; dismiss: () => void } {
  const [pinned, setPinned] = useState<ToastState | null>(null);
  const [transient, setTransient] = useState<ToastState | null>(null);
  // 普通提示那条通道的定时器。**必须存下来按掉**：不按的话，前一句遗留的定时器会把后一句
  // 提前扫掉（它只认自己那条通道，扫不到常驻那句）。
  const timer = useRef<number | null>(null);
  const clear = () => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
  };
  const notify = useCallback<Notify>((message, options) => {
    if (options?.sticky) {
      // 新的常驻报错顶掉旧的：一次只钉一句，最新那次失败才是用户此刻在处理的事。
      setPinned({ message });
      return;
    }
    clear();
    setTransient({ message });
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setTransient((current) => current && current.message === message ? null : current);
    }, 2600);
  }, []);
  const dismiss = useCallback(() => setPinned(null), []);
  return { toasts: { pinned, transient }, notify, dismiss };
}

/**
 * 一句提示。挂上去和收回去各留一次淡入淡出：内容为空时整个摘掉（空槽位不占位置，否则
 * 另一句会被顶得离屏幕边老远），所以淡出要等动画走完再卸载。
 */
function ToastSlot({
  toast, testId, pinned = false, onDismiss, onOpenSettings,
}: {
  toast: ToastState | null;
  testId: string;
  pinned?: boolean;
  onDismiss?: () => void;
  onOpenSettings?: (section: SettingsSection, anchor: string | null) => void;
}) {
  const [mounted, setMounted] = useState<ToastState | null>(toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (toast) {
      setMounted(toast);
      const frame = window.requestAnimationFrame(() => setVisible(true));
      return () => window.cancelAnimationFrame(frame);
    }
    setVisible(false);
    const timer = window.setTimeout(() => setMounted(null), 200); // 与 CSS 里的 150ms 淡出对齐
    return () => window.clearTimeout(timer);
  }, [toast]);
  if (!mounted) return null;
  // 常驻那一句得能点：文字要选得中、抄得走，右上角给一颗关闭。普通提示保持
  // pointer-events: none（样式里给），别挡住底下的界面。
  return (
    <div className={`workspace-toast${visible ? " is-visible" : ""}${pinned ? " is-sticky" : ""}`} data-testid={testId} role="status" aria-live="polite">
      <span className="workspace-toast-text">
        {onOpenSettings
          ? <SettingsPathText text={mounted.message} onOpen={onOpenSettings} />
          : mounted.message}
      </span>
      {pinned && (
        <button type="button" className="workspace-toast-close" aria-label="关闭提示" onClick={onDismiss}>
          <X size={12} />
        </button>
      )}
    </div>
  );
}

export function WorkspaceToast({ toasts, onDismiss, onOpenSettings }: {
  toasts: ToastSlots;
  onDismiss: () => void;
  /** 接上「设置 → …」那条路的跳转；不给就只当普通文字显示。 */
  onOpenSettings?: (section: SettingsSection, anchor: string | null) => void;
}) {
  return (
    <div className="workspace-toasts">
      <ToastSlot toast={toasts.pinned} testId="workspace-toast-pinned" pinned onDismiss={onDismiss} onOpenSettings={onOpenSettings} />
      {/* 普通提示两秒多就走，而且整条 `pointer-events: none`（别挡住底下的界面）——
          在那上面画一颗点不着、又马上消失的链接，比不画更糟。 */}
      <ToastSlot toast={toasts.transient} testId="workspace-toast-transient" />
    </div>
  );
}
