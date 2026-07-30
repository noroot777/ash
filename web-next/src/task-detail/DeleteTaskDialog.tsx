import { useEffect, useState } from "react";
import type { Task, TaskWorkspaceLeftover } from "@harness/shared";
import { GitBranch, TreeStructure } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { LegacyLink } from "../components/LegacyLink.tsx";
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

  useEffect(() => {
    let alive = true;
    api.taskWorkspace(task.id)
      .then((workspace) => { if (alive && (workspace.path || workspace.branch)) setLeftover(workspace); })
      .catch(() => undefined)
      .finally(() => { if (alive) setProbing(false); });
    return () => { alive = false; };
  }, [task.id]);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.deleteTask(task.id, {
        worktree: cleanup && !!leftover?.path,
        branch: cleanup && !!leftover?.branch,
      });
      const cleanupError = result.cleanup?.worktreeError || result.cleanup?.branchError;
      if (cleanupError) notify(`任务已删除，但 Git 清理未完成：${cleanupError}`);
      else notify("任务已删除");
      onDeleted();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

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
          <small>需要处理未提交改动或强制清理时，请先用旧版打开。</small>
          <LegacyLink projectId={task.projectId} taskId={task.id} />
        </div>
      )}
      {error && <p className="task-delete-error">{error}</p>}
    </ConfirmDialog>
  );
}
