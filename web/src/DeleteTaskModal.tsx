import { useEffect, useState } from "react";
import { TreeStructure, GitBranch, Warning } from "@phosphor-icons/react";
import type { Task, TaskWorkspaceLeftover, TaskWorkspaceDiscardResult } from "@harness/shared";
import { Modal } from "./Modal";
import { api } from "./api";
import { toast } from "./toast";

// ── 删除任务 ────────────────────────────────────────────────────────────────
// 删除任务不只是删一行数据:跑过 worktree 的任务在磁盘上留着 `.worktrees/<id>`
// 目录和 `harness/<id8>` 分支,任务一没,这两样就再也没有入口能看到它们。所以这
// 个对话框在打开时先问一次服务端还留着什么,有残留就直接在确认里给一个「连它们
// 一起删」的勾选(默认勾上 —— 大多数时候删任务就是想删干净;git 自己的安全检查
// 会挡住有未提交改动 / 未合并提交的情况,那时再由用户决定要不要强制)。
//
// 删除本身永远会成功:git 清理失败不回滚删除,只把 git 的原话摆出来 + 给一个
// 「强制删除」的第二次机会(worktree --force / 分支 -D),或者就这么留着。
export function DeleteTaskModal({
  task,
  onClose,
  onDeleted,
}: {
  task: Task;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const [leftover, setLeftover] = useState<TaskWorkspaceLeftover | null>(null);
  const [probing, setProbing] = useState(true);
  const [discard, setDiscard] = useState(true);
  const [busy, setBusy] = useState(false);
  // 删除已经发生之后的状态:cleanup 是本次清理结果,error 是删除请求本身失败。
  const [cleanup, setCleanup] = useState<TaskWorkspaceDiscardResult | null>(null);
  const [rest, setRest] = useState<TaskWorkspaceLeftover | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .taskWorkspace(task.id)
      .then((w) => { if (alive) setLeftover(w.path || w.branch ? w : null); })
      .catch(() => {})
      .finally(() => { if (alive) setProbing(false); });
    return () => { alive = false; };
  }, [task.id]);

  const del = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.deleteTask(task.id, {
        worktree: discard && !!leftover?.path,
        branch: discard && !!leftover?.branch,
      });
      onDeleted(task.id);
      const remaining = res.leftover?.path || res.leftover?.branch ? res.leftover : null;
      const failed = !!(res.cleanup?.worktreeError || res.cleanup?.branchError);
      // 没勾清理、或清理干净了就直接关;只有「勾了却没删掉」才留在这儿追问一次。
      if (failed && remaining) {
        setCleanup(res.cleanup);
        setRest(remaining);
      } else {
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const forceDiscard = async () => {
    setBusy(true);
    try {
      const res = await api.discardTaskWorkspace(task.projectId, {
        taskId: task.id,
        worktree: !!rest?.path,
        branch: !!rest?.branch,
        force: true,
      });
      const stillPath = res.worktreeRemoved ? null : rest?.path ?? null;
      const stillBranch = res.branchDeleted ? null : rest?.branch ?? null;
      // 都删掉了就没什么可看的了 —— 留着一个空对话框比关掉更让人困惑。
      if (!stillPath && !stillBranch) {
        toast("worktree 和分支已删除", "info");
        onClose();
        return;
      }
      setCleanup(res);
      setRest({ path: stillPath, branch: stillBranch });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // 第二幕:任务已经删了,但 worktree/分支没(全)删掉。标题和正文只说**实际剩下的
  // 那一样** —— 分支未合并、worktree 却删干净了是最常见的一种,这时说「worktree/
  // 分支没删掉」就是在瞎报,用户会以为磁盘上还有个目录。
  if (rest) {
    const stillFailing = !!(cleanup?.worktreeError || cleanup?.branchError);
    const restLabel = rest.path && rest.branch ? "worktree 和分支" : rest.path ? "worktree" : "分支";
    // 目录删了、分支留着:提交并没有丢,说清楚,免得用户以为工作没了而去强制删。
    const worktreeGone = !rest.path && !!cleanup?.worktreeRemoved;
    return (
      <Modal
        title={`任务已删除，${restLabel}没删掉`}
        onClose={onClose}
        width={520}
        footer={(close) => (
          <>
            <button onClick={close} className="px-3 py-1.5 text-[13px] text-muted">
              先留着
            </button>
            {stillFailing && (
              <button
                autoFocus
                disabled={busy}
                onClick={forceDiscard}
                className="rounded-md bg-red-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-red-700 disabled:opacity-40"
              >
                {busy ? "删除中…" : "强制删除（--force / -D）"}
              </button>
            )}
          </>
        )}
      >
        <div className="space-y-2.5 text-[13px] text-ink">
          {worktreeGone && (
            <p className="text-[12px] text-muted">
              worktree 目录已删除；分支还留着,<strong>里面的提交没丢</strong>。
            </p>
          )}
          <WorkspaceBox path={rest.path} branch={rest.branch} />
          {cleanup?.worktreeError && <GitStderr text={cleanup.worktreeError} />}
          {cleanup?.branchError && <GitStderr text={cleanup.branchError} />}
          {error && <GitStderr text={error} />}
          <p className="flex items-start gap-1.5 text-[12px] text-faint">
            <Warning size={13} className="mt-px shrink-0 text-amber-500" />
            <span>
              git 拒绝一般是因为里面还有<strong>未提交的改动</strong>或<strong>未合并的提交</strong>。
              强制删除会把它们直接丢掉,救不回来。
            </span>
          </p>
        </div>
      </Modal>
    );
  }

  // 第一幕:删不删,以及要不要连 worktree 和分支一起删。
  return (
    <Modal
      title="删除任务"
      onClose={onClose}
      width={leftover ? 520 : 440}
      footer={() => (
        <>
          <button onClick={onClose} className="px-3 py-1.5 text-[13px] text-muted">
            取消
          </button>
          <button
            autoFocus
            disabled={busy || probing}
            onClick={del}
            className="rounded-md bg-red-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-red-700 disabled:opacity-40"
          >
            {busy ? "删除中…" : leftover && discard ? "一起删除" : "删除"}
          </button>
        </>
      )}
    >
      <div className="space-y-2.5 text-[13px] text-ink">
        <p>
          确定删除任务「{task.title || "未命名任务"}」？此操作不可撤销。
        </p>
        {probing && <p className="text-[12px] text-faint">正在检查 worktree 和分支…</p>}
        {leftover && (
          <>
            <p className="text-muted">这个任务还留着:</p>
            <WorkspaceBox path={leftover.path} branch={leftover.branch} />
            <label className="flex cursor-pointer items-start gap-2 rounded-md border border-line bg-raised px-2.5 py-2">
              <input
                type="checkbox"
                checked={discard}
                onChange={(e) => setDiscard(e.target.checked)}
                className="mt-0.5 accent-red-600"
              />
              <span className="text-[13px] leading-snug">
                连{leftover.path ? " worktree 目录" : ""}
                {leftover.path && leftover.branch ? "和" : ""}
                {leftover.branch ? "分支" : ""}一起删除
                <span className="mt-0.5 block text-[12px] text-faint">
                  有未提交改动或未合并提交时 git 会拒绝,到时再单独确认是否强制删除。
                  {task.mode === "team" && " 团队执行者共享这个 worktree,删掉他们的工作目录也就没了。"}
                </span>
              </span>
            </label>
          </>
        )}
        {error && <GitStderr text={error} />}
      </div>
    </Modal>
  );
}

function WorkspaceBox({ path, branch }: { path: string | null; branch: string | null }) {
  return (
    <div className="rounded-md border border-line bg-raised px-2.5 py-2 font-mono text-[12px]">
      {path && (
        <div className="flex items-center gap-1.5 break-all text-ink">
          <TreeStructure size={12} className="shrink-0 text-faint" />
          {path}
        </div>
      )}
      {branch && (
        <div className={`flex items-center gap-1.5 text-muted ${path ? "mt-1" : ""}`}>
          <GitBranch size={11} className="shrink-0 text-faint" />
          {branch}
        </div>
      )}
    </div>
  );
}

function GitStderr({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap rounded-md border border-red-300 bg-red-50 px-2.5 py-1.5 text-[12px] leading-snug text-red-700">
      {text}
    </pre>
  );
}
