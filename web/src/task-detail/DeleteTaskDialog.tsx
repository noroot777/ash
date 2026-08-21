import { useEffect, useState } from "react";
import type { Task, TaskWorkspaceDiscardResult, TaskWorkspaceLeftover } from "@ash/shared";
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
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probeAttempt, setProbeAttempt] = useState(0);
  // 探测失败后「我知道，只删任务」的显式确认。没有它就不放行删除按钮。
  const [keepWorkspaceAck, setKeepWorkspaceAck] = useState(false);
  const [cleanup, setCleanup] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [rest, setRest] = useState<LeftoverItem[] | null>(null);
  // 这一次删除到底有没有请求清理——残留对话框的措辞得按它说话。
  const [requestedCleanup, setRequestedCleanup] = useState(false);

  useEffect(() => {
    let alive = true;
    setProbing(true);
    setProbeError(null);
    setKeepWorkspaceAck(false);
    api.taskWorkspace(task.id)
      .then((workspace) => {
        if (!alive) return;
        setProbe(workspace.path || workspace.branch || workspace.children?.length ? workspace : null);
      })
      // 探测失败不能吞：吞了之后 anyPath/anyBranch 全为 false，删除请求一个清理参数都不带，
      // 服务端只删任务行并如实回报残留，UI 却把它读成「Git 拒绝了普通清理」——既误报原因，
      // 又让用户勾的清理意图一次都没执行（审查实测）。改成持久显示，要么重试、要么显式
      // 选「只删任务」。
      .catch((reason) => { if (alive) setProbeError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (alive) setProbing(false); });
    return () => { alive = false; };
  }, [task.id, probeAttempt]);

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
      // 探测没成功就没有可信的清理目标：此时唯一放行的路径是用户显式选了「只删任务」，
      // 那就如实按不清理发出去，也不会再把返回的残留说成「Git 拒绝」。
      const wantCleanup = cleanup && !probeError;
      setRequestedCleanup(wantCleanup && (anyPath || anyBranch));
      const result = await api.deleteTask(task.id, {
        worktree: wantCleanup && anyPath,
        branch: wantCleanup && anyBranch,
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
      if (items.length && (wantCleanup || items.some((item) => item.cleanup))) {
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
    const still: LeftoverItem[] = [];
    let failure: string | null = null;
    // 逐项各自 catch，一项炸了继续处理后面的：整批 try 包起来的话，第一项已经删掉、
    // 第二项请求抛错时外层 rest 还是老那份，用户重试会对着已删项再发一遍，服务端返回
    // removed=false，那条路径/分支就被永久留在列表里（审查实测）。已完成的进度必须落下来。
    for (const item of rest) {
      try {
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
      } catch (reason) {
        // 请求本身失败：这一项的实际状态未知，按「仍在」留着让用户再来一次。
        failure = reason instanceof Error ? reason.message : String(reason);
        still.push(item);
      }
    }
    setBusy(false);
    setError(failure);
    if (!still.length) {
      finishDeleted("任务和 Git 残留已删除", deletedIds);
      return;
    }
    setRest(still);
  };

  if (rest) {
    return (
      <ConfirmDialog
        title="任务已删除，Git 仍有残留"
        message={`${requestedCleanup ? "Git 拒绝了普通清理。" : "这次删除按你的选择没有清理 worktree / 分支。"}选择“先保留”会留下下面的残留；再次确认会强制丢弃未提交改动或未合并提交。`}
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
      confirmLabel={probeError ? "只删任务" : probe && cleanup ? "一起删除" : "删除"}
      busy={busy || probing}
      confirmDisabled={!!probeError && !keepWorkspaceAck}
      danger
      onConfirm={() => void remove()}
      onClose={onClose}
    >
      {probing && <p className="task-delete-probe">正在检查 worktree 和分支…</p>}
      {probeError && !probing && (
        <div className="task-delete-workspace">
          <p className="task-delete-error">worktree / 分支检查失败：{probeError}</p>
          <small>检查没成功就不知道该清理什么，这一删只会删掉任务行；worktree 和分支（如果有）会原样留在磁盘上。</small>
          <button type="button" onClick={() => setProbeAttempt((value) => value + 1)}>重新检查</button>
          <label>
            <input type="checkbox" checked={keepWorkspaceAck} onChange={(event) => setKeepWorkspaceAck(event.target.checked)} />
            知道了，只删任务，保留可能存在的 worktree / 分支
          </label>
        </div>
      )}
      {probe && !probeError && (
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
