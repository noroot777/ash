import { useEffect, useState } from "react";
import type { Task, TaskWorkspaceDiscardResult, TaskWorkspaceLeftover } from "@harness/shared";
import { GitBranch, TreeStructure, Warning } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

export function DeleteTaskDialog({
  task,
  onDeleted,
  onClose,
  notify,
}: {
  task: Task;
  onDeleted: () => void;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const [leftover, setLeftover] = useState<TaskWorkspaceLeftover | null>(null);
  const [probing, setProbing] = useState(true);
  const [cleanup, setCleanup] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cleanupResult, setCleanupResult] = useState<TaskWorkspaceDiscardResult | null>(null);
  const [rest, setRest] = useState<TaskWorkspaceLeftover | null>(null);

  useEffect(() => {
    let alive = true;
    api.taskWorkspace(task.id)
      .then((workspace) => { if (alive && (workspace.path || workspace.branch)) setLeftover(workspace); })
      .catch(() => undefined)
      .finally(() => { if (alive) setProbing(false); });
    return () => { alive = false; };
  }, [task.id]);

  const finishDeleted = (message: string) => {
    notify(message);
    onClose();
    onDeleted();
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.deleteTask(task.id, {
        worktree: cleanup && !!leftover?.path,
        branch: cleanup && !!leftover?.branch,
      });
      const remaining = result.leftover?.path || result.leftover?.branch ? result.leftover : null;
      const cleanupFailed = !!(result.cleanup?.worktreeError || result.cleanup?.branchError);
      if (cleanupFailed && remaining) {
        setCleanupResult(result.cleanup);
        setRest(remaining);
        return;
      }
      finishDeleted("任务已删除");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const forceDiscard = async () => {
    if (!rest) return;
    const removedLabel = rest.path && rest.branch ? "worktree 和分支" : rest.path ? "worktree" : "分支";
    setBusy(true);
    setError(null);
    try {
      const result = await api.discardTaskWorkspace(task.projectId, {
        taskId: task.id,
        worktree: !!rest.path,
        branch: !!rest.branch,
        force: true,
      });
      const stillPath = result.worktreeRemoved ? null : rest.path;
      const stillBranch = result.branchDeleted ? null : rest.branch;
      if (!stillPath && !stillBranch) {
        finishDeleted(`任务和${removedLabel}已删除`);
        return;
      }
      setCleanupResult(result);
      setRest({ path: stillPath, branch: stillBranch });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (rest) {
    const restLabel = rest.path && rest.branch ? "worktree 和分支" : rest.path ? "worktree" : "分支";
    const forceLabel = rest.path && rest.branch
      ? "强制清理（--force / -D）"
      : rest.path ? "强制删除 worktree（--force）" : "强制删除分支（-D）";
    return (
      <ConfirmDialog
        title={`任务已删除，${restLabel}仍有残留`}
        message="Git 拒绝了普通清理。选择“先保留”会留下下面的残留；再次确认会强制丢弃未提交改动或未合并提交。"
        confirmLabel={forceLabel}
        cancelLabel="先保留"
        busy={busy}
        danger
        onConfirm={() => void forceDiscard()}
        onClose={() => finishDeleted("任务已删除，Git 残留已保留")}
      >
        <div className="task-delete-force">
          {!rest.path && cleanupResult?.worktreeRemoved && (
            <p className="task-delete-note">worktree 目录已删除；分支仍保留，分支里的提交还在。</p>
          )}
          {rest.path && (
            <CleanupFailure
              icon={<TreeStructure size={13} aria-hidden="true" />}
              kind="worktree"
              value={rest.path}
              stderr={cleanupResult?.worktreeError}
            />
          )}
          {rest.branch && (
            <CleanupFailure
              icon={<GitBranch size={13} aria-hidden="true" />}
              kind="分支"
              value={rest.branch}
              stderr={cleanupResult?.branchError}
            />
          )}
          {error && <pre className="task-delete-stderr">{error}</pre>}
          <p className="task-delete-warning">
            <Warning size={13} aria-hidden="true" />
            强制清理不可恢复；请仅在确认这些改动和提交不再需要时继续。
          </p>
        </div>
      </ConfirmDialog>
    );
  }

  return (
    <ConfirmDialog
      title="删除任务"
      message={`确定删除“${task.title || "未命名任务"}”？此操作不可撤销。`}
      confirmLabel={leftover && cleanup ? "一起删除" : "删除"}
      busy={busy || probing}
      danger
      onConfirm={() => void remove()}
      onClose={onClose}
    >
      {probing && <p className="task-delete-probe">正在检查 worktree 和分支…</p>}
      {leftover && (
        <div className="task-delete-workspace">
          {leftover.path && <p><TreeStructure size={13} />{leftover.path}</p>}
          {leftover.branch && <p><GitBranch size={13} />{leftover.branch}</p>}
          <label>
            <input type="checkbox" checked={cleanup} onChange={(event) => setCleanup(event.target.checked)} />
            连 worktree / 分支一起清理
          </label>
          <small>普通清理被 Git 拒绝时，会在下一步显示原始错误并单独确认是否强制删除。</small>
        </div>
      )}
      {error && <p className="task-delete-error">{error}</p>}
    </ConfirmDialog>
  );
}

function CleanupFailure({
  icon,
  kind,
  value,
  stderr,
}: {
  icon: React.ReactNode;
  kind: string;
  value: string;
  stderr?: string | null;
}) {
  return (
    <section className="task-delete-failure">
      <header>{icon}<span>{kind}</span><code>{value}</code></header>
      {stderr && <pre className="task-delete-stderr">{stderr}</pre>}
    </section>
  );
}
