import { useEffect, useState } from "react";
import type { Task, TaskWorkspaceDiscardResult, TaskWorkspaceLeftover } from "@harness/shared";
import { GitBranch, TreeStructure, Warning } from "@phosphor-icons/react";
import { api, type TaskWorkspaceProbe } from "../lib/api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

// 一条待收拾的 Git 残留（父任务本身，或已连行删除的 child）。child 的任务行删除后唯一
// 还能清它的入口是 /projects/:id/workspaces/discard（按 taskId 推导路径，不查任务表），
// 所以强清阶段父与 child 走同一条路，逐项处理。
type LeftoverItem = {
  taskId: string;
  label: string | null; // child 标题；父任务为 null
  path: string | null;
  branch: string | null;
  cleanup: TaskWorkspaceDiscardResult | null;
};

function itemsFromLeftovers(
  parent: { taskId: string; leftover: TaskWorkspaceLeftover | null; cleanup: TaskWorkspaceDiscardResult | null },
  childLeftovers: { taskId: string; leftover: TaskWorkspaceLeftover }[],
  childCleanups: (TaskWorkspaceDiscardResult & { taskId: string })[],
  childTitles: Map<string, string>,
): LeftoverItem[] {
  const items: LeftoverItem[] = [];
  if (parent.leftover?.path || parent.leftover?.branch) {
    items.push({
      taskId: parent.taskId,
      label: null,
      path: parent.leftover.path,
      branch: parent.leftover.branch,
      cleanup: parent.cleanup,
    });
  }
  for (const child of childLeftovers) {
    items.push({
      taskId: child.taskId,
      label: childTitles.get(child.taskId) ?? child.taskId,
      path: child.leftover.path,
      branch: child.leftover.branch,
      cleanup: childCleanups.find((cleanup) => cleanup.taskId === child.taskId) ?? null,
    });
  }
  return items;
}

export function DeleteTaskDialog({
  task,
  onDeleted,
  onClose,
  notify,
}: {
  task: Task;
  onDeleted: (deletedTaskIds: string[]) => void;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const [probe, setProbe] = useState<TaskWorkspaceProbe | null>(null);
  const [probing, setProbing] = useState(true);
  const [cleanup, setCleanup] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [rest, setRest] = useState<LeftoverItem[] | null>(null);

  useEffect(() => {
    let alive = true;
    api.taskWorkspace(task.id)
      .then((workspace) => {
        if (alive && (workspace.path || workspace.branch || workspace.children?.length)) setProbe(workspace);
      })
      .catch(() => undefined)
      .finally(() => { if (alive) setProbing(false); });
    return () => { alive = false; };
  }, [task.id]);

  const finishDeleted = (message: string, ids: string[]) => {
    notify(message);
    onClose();
    onDeleted(ids.length ? ids : [task.id]);
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      // 清理参数按「父或任一 child 有对应残留」设置：父没有 worktree、child 有时也必须
      // 带上参数，否则服务端对 children 一个字都不清（child 行已删，之后没有入口补救）。
      const anyPath = !!probe?.path || !!probe?.children?.some((child) => child.path);
      const anyBranch = !!probe?.branch || !!probe?.children?.some((child) => child.branch);
      const result = await api.deleteTask(task.id, {
        worktree: cleanup && anyPath,
        branch: cleanup && anyBranch,
      });
      const ids = result.deletedTaskIds ?? [task.id];
      setDeletedIds(ids);
      const childTitles = new Map((probe?.children ?? []).map((child) => [child.taskId, child.title ?? child.taskId]));
      const items = itemsFromLeftovers(
        { taskId: task.id, leftover: result.leftover, cleanup: result.cleanup },
        result.childLeftovers ?? [],
        result.childCleanups ?? [],
        childTitles,
      );
      if (items.length && (cleanup || items.some((item) => item.cleanup))) {
        // 勾了清理却仍有残留（Git 拒绝），或部分清理失败：如实列出来再问一次。
        setRest(items);
        return;
      }
      if (items.length) {
        finishDeleted("任务已删除，worktree / 分支按选择保留", ids);
        return;
      }
      finishDeleted("任务已删除", ids);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const forceDiscard = async () => {
    if (!rest?.length) return;
    setBusy(true);
    setError(null);
    try {
      const still: LeftoverItem[] = [];
      for (const item of rest) {
        const result = await api.discardTaskWorkspace(task.projectId, {
          taskId: item.taskId,
          worktree: !!item.path,
          branch: !!item.branch,
          force: true,
        });
        const stillPath = result.worktreeRemoved ? null : item.path;
        const stillBranch = result.branchDeleted ? null : item.branch;
        if (stillPath || stillBranch) {
          still.push({ ...item, path: stillPath, branch: stillBranch, cleanup: result });
        }
      }
      if (!still.length) {
        finishDeleted("任务和 Git 残留已删除", deletedIds);
        return;
      }
      setRest(still);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (rest) {
    return (
      <ConfirmDialog
        title="任务已删除，Git 仍有残留"
        message="Git 拒绝了普通清理。选择“先保留”会留下下面的残留；再次确认会强制丢弃未提交改动或未合并提交。"
        confirmLabel="强制清理（--force / -D）"
        cancelLabel="先保留"
        busy={busy}
        danger
        onConfirm={() => void forceDiscard()}
        onClose={() => finishDeleted("任务已删除，Git 残留已保留", deletedIds)}
      >
        <div className="task-delete-force">
          {rest.map((item) => (
            <section key={item.taskId} className="task-delete-failure">
              {item.label && <header><span>执行者</span><code>{item.label}</code></header>}
              {item.path && (
                <CleanupFailure
                  icon={<TreeStructure size={13} aria-hidden="true" />}
                  kind="worktree"
                  value={item.path}
                  stderr={item.cleanup?.worktreeError}
                />
              )}
              {item.branch && (
                <CleanupFailure
                  icon={<GitBranch size={13} aria-hidden="true" />}
                  kind="分支"
                  value={item.branch}
                  stderr={item.cleanup?.branchError}
                />
              )}
            </section>
          ))}
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
      confirmLabel={probe && cleanup ? "一起删除" : "删除"}
      busy={busy || probing}
      danger
      onConfirm={() => void remove()}
      onClose={onClose}
    >
      {probing && <p className="task-delete-probe">正在检查 worktree 和分支…</p>}
      {probe && (
        <div className="task-delete-workspace">
          {probe.path && <p><TreeStructure size={13} />{probe.path}</p>}
          {probe.branch && <p><GitBranch size={13} />{probe.branch}</p>}
          {probe.children?.map((child) => (
            <div key={child.taskId} className="task-delete-child">
              <small>执行者「{child.title ?? child.taskId}」（随任务一并删除）</small>
              {child.path && <p><TreeStructure size={13} />{child.path}</p>}
              {child.branch && <p><GitBranch size={13} />{child.branch}</p>}
            </div>
          ))}
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
