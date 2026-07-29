import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import { X } from "@phosphor-icons/react";
import { useEscape } from "./useEscape";
import { useReveal } from "./useReveal";
import { Kbd, PathHealth, submitShortcutTitle } from "./ui";

// Shared modal shell: dimmed overlay, centered card, Esc-close, click-outside,
// width prop. One consistent style for every dialog in the app. The card rises +
// scales in on open and dips back down on close (transitions.dev `.t-modal`); the
// close affordances (Esc / click-outside / ✕) route through `requestClose` so the
// exit animation plays before the parent unmounts. A footer that needs to dismiss
// with the same animation takes the function form `(close) => …`.
export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 560,
  cardClassName = "",
  cardRef,
  cardStyle,
  contentClassName = "overflow-y-auto p-4",
  headerActions,
  headerProps,
  overlayClassName = "z-50",
  beforeClose,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode | ((close: () => void) => ReactNode);
  width?: number;
  cardClassName?: string;
  cardRef?: Ref<HTMLDivElement>;
  cardStyle?: CSSProperties;
  contentClassName?: string;
  headerActions?: ReactNode;
  headerProps?: HTMLAttributes<HTMLDivElement>;
  overlayClassName?: string;
  beforeClose?: () => boolean | Promise<boolean>;
}) {
  const { closing, requestClose: revealClose } = useReveal(onClose, "--modal-close-dur");
  const checkingClose = useRef(false);
  const requestClose = useCallback(() => {
    if (!beforeClose) {
      revealClose();
      return;
    }
    if (checkingClose.current) return;
    checkingClose.current = true;
    void Promise.resolve(beforeClose()).then((allowed) => {
      checkingClose.current = false;
      if (allowed !== false) revealClose();
    }, () => {
      checkingClose.current = false;
    });
  }, [beforeClose, revealClose]);
  useEscape(requestClose);
  return (
    <div
      className={`t-modal-overlay ${closing ? "is-closing" : ""} fixed inset-0 ${overlayClassName} flex items-start justify-center bg-black/30 pt-[14vh]`}
      onClick={requestClose}
    >
      <div
        ref={cardRef}
        className={`t-modal ${closing ? "is-closing" : ""} flex max-h-[80vh] w-full flex-col overflow-hidden rounded-xl border border-line2 bg-panel shadow-2xl ${cardClassName}`}
        style={{ width, maxWidth: "94vw", ...cardStyle }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          {...headerProps}
          className={`flex shrink-0 items-center justify-between border-b border-line px-4 py-3 ${headerProps?.className ?? ""}`}
        >
          <h2 className="min-w-0 truncate text-[14px] font-semibold text-ink">{title}</h2>
          <div className="ml-3 flex shrink-0 items-center gap-1">
            {headerActions}
            <button onClick={requestClose} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className={`flex-1 ${contentClassName}`}>{children}</div>
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
            {typeof footer === "function" ? footer(requestClose) : footer}
          </div>
        )}
      </div>
    </div>
  );
}

export const fieldCls =
  "w-full rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint focus:border-accent";
export const primaryCls =
  "rounded-md bg-accent px-3.5 py-1.5 text-[13px] font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40";

// Styled confirm dialog (replaces window.confirm) — app-consistent, Esc-closable.
export function ConfirmModal({
  title,
  message,
  confirmLabel = "确定",
  danger = false,
  onConfirm,
  onClose,
  overlayClassName,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  overlayClassName?: string;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={420}
      overlayClassName={overlayClassName}
      footer={(close) => (
        <>
          <button onClick={close} className="px-3 py-1.5 text-[13px] text-muted">取消</button>
          <button
            autoFocus
            onClick={() => {
              onConfirm();
              close();
            }}
            className={
              danger
                ? "rounded-md bg-red-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-red-700"
                : primaryCls
            }
          >
            {confirmLabel}
          </button>
        </>
      )}
    >
      <p className="text-[13px] leading-relaxed text-ink">{message}</p>
    </Modal>
  );
}

export function NewProjectModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, repoPath: string) => void;
}) {
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const submit = () => name.trim() && onCreate(name.trim(), repoPath.trim());
  return (
    <Modal
      title="新建项目"
      onClose={onClose}
      footer={(close) => (
        <>
          <button onClick={close} className="px-3 py-1.5 text-[13px] text-muted">取消</button>
          <button disabled={!name.trim()} onClick={submit} title={submitShortcutTitle("创建项目")} className={`${primaryCls} inline-flex items-center gap-1.5`}>
            创建 <Kbd />
          </button>
        </>
      )}
    >
      <div className="flex flex-col gap-3" onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && submit()}>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-muted">项目名称</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="如 my-app" className={fieldCls} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-muted">工作目录</span>
          <span className="text-[11px] text-faint">任务将在此目录运行；若为 git 仓库，可额外使用分支、diff 和 worktree 能力。</span>
          <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="/Users/you/code/my-app" className={`${fieldCls} font-mono`} />
          <PathHealth path={repoPath} />
        </label>
      </div>
    </Modal>
  );
}

export function NewGroupModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, mode: "parallel" | "serial") => void;
}) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"parallel" | "serial">("parallel");
  const submit = () => name.trim() && onCreate(name.trim(), mode);
  return (
    <Modal
      title="新建分组"
      onClose={onClose}
      footer={(close) => (
        <>
          <button onClick={close} className="px-3 py-1.5 text-[13px] text-muted">取消</button>
          <button disabled={!name.trim()} onClick={submit} title={submitShortcutTitle("创建分组")} className={`${primaryCls} inline-flex items-center gap-1.5`}>
            创建 <Kbd />
          </button>
        </>
      )}
    >
      <div className="flex flex-col gap-3" onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && submit()}>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-muted">分组名称</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="如 批量重构" className={fieldCls} />
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-muted">运行方式</span>
          <div className="flex gap-2">
            {(["parallel", "serial"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 rounded-md border px-3 py-2 text-[13px] ${
                  mode === m ? "border-accent bg-accent/8 text-ink" : "border-line text-muted hover:bg-raised"
                }`}
              >
                {m === "parallel" ? "并行" : "串行"}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
