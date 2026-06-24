import { useState, type ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import { useEscape } from "./useEscape";
import { useReveal } from "./useReveal";
import { PathHealth } from "./ui";

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
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode | ((close: () => void) => ReactNode);
  width?: number;
}) {
  const { closing, requestClose } = useReveal(onClose, "--modal-close-dur");
  useEscape(requestClose);
  return (
    <div
      className={`t-modal-overlay ${closing ? "is-closing" : ""} fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[14vh]`}
      onClick={requestClose}
    >
      <div
        className={`t-modal ${closing ? "is-closing" : ""} flex max-h-[80vh] w-full flex-col overflow-hidden rounded-xl border border-line2 bg-panel shadow-2xl`}
        style={{ width, maxWidth: "94vw" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
          <button onClick={requestClose} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
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
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={420}
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
          <button disabled={!name.trim()} onClick={submit} className={primaryCls}>创建</button>
        </>
      )}
    >
      <div className="flex flex-col gap-3" onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && submit()}>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-muted">项目名称</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="如 my-app" className={fieldCls} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-muted">git 仓库路径</span>
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
          <button disabled={!name.trim()} onClick={submit} className={primaryCls}>创建</button>
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
