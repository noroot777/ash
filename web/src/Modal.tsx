import { useState, type ReactNode } from "react";
import { X, TreeStructure, GitBranch } from "@phosphor-icons/react";
import { useEscape } from "./useEscape";
import { useReveal } from "./useReveal";
import { PathHealth } from "./ui";
import { api } from "./api";

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

// Shown after deleting a task that had `useWorktree`: surfaces the leftover
// worktree path + branch and offers a one-click cleanup. First click runs
// `git worktree remove`; if that fails (typically because the worktree is dirty
// or has unmerged commits), we show the raw git stderr and enable a 「强制清理」
// retry that adds `--force`. harness never touches the branch — that's still a
// user-driven `git branch -D` if they want it gone.
export function WorktreeCleanupModal({
  projectId,
  path,
  branch,
  onClose,
}: {
  projectId: string;
  path: string;
  branch: string;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // Once a non-forced attempt fails we surface a second button that retries with
  // --force; if the first attempt succeeded `done` flips and we just show OK.
  const [forceArmed, setForceArmed] = useState(false);
  const clean = async (force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.removeWorktree(projectId, path, force);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setForceArmed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="任务已删除"
      onClose={onClose}
      width={480}
      footer={(close) => (
        <>
          <button onClick={close} className="px-3 py-1.5 text-[13px] text-muted">
            {done ? "关闭" : "保留 worktree"}
          </button>
          {!done && (
            <button
              autoFocus
              disabled={busy}
              onClick={() => clean(forceArmed)}
              className="rounded-md bg-red-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-red-700 disabled:opacity-40"
            >
              {busy ? "清理中…" : forceArmed ? "强制清理（--force）" : "清理 worktree"}
            </button>
          )}
        </>
      )}
    >
      <div className="space-y-2.5 text-[13px] text-ink">
        {done ? (
          <p className="text-emerald-600">worktree 已删除。分支 <code className="rounded bg-raised px-1 py-px text-[12px] text-muted">{branch}</code> 仍在，需要时自行 <code className="rounded bg-raised px-1 py-px text-[12px] text-muted">git branch -D {branch}</code>。</p>
        ) : (
          <>
            <p className="text-muted">这个任务用过 worktree，目录还在磁盘上：</p>
            <div className="rounded-md border border-line bg-raised px-2.5 py-2 font-mono text-[12px]">
              <div className="flex items-center gap-1.5 text-ink">
                <TreeStructure size={12} className="text-faint" />
                {path}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-muted">
                <GitBranch size={11} className="text-faint" />
                {branch}
              </div>
            </div>
            {error && (
              <pre className="whitespace-pre-wrap rounded-md border border-red-300 bg-red-50 px-2.5 py-1.5 text-[12px] leading-snug text-red-700">
                {error}
              </pre>
            )}
            <p className="text-[12px] text-faint">
              清理只移除 worktree 目录，<strong>不删分支</strong>。
            </p>
          </>
        )}
      </div>
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
