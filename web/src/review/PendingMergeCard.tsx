import { useCallback, useEffect, useState } from "react";
import { ArrowClockwise, GitCommit, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import type { PendingMergeState } from "@ash/shared/accept-pending";
import type { Task, TaskListItem } from "@ash/shared";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { AcceptCommitChoice, useAcceptCommitDefault } from "./AcceptCommitChoice.tsx";

// 「合并后不提交」那一档验收完之后的**常驻**状态卡。
//
// 为什么必须常驻（现场，2026-09-15）：那一档验收完，界面上只剩一句和正常验收一模一样的
// 「✓ 验收完成」，欠的那一步只活在一个 toast（刷新就没）和时间线深处（得翻历史）。用户
// 因此完全看不出还欠一步，也找不到地方收尾，最后手工 merge --no-ff 补进目标分支。判据
// 按根 AGENTS.md「停止/暂停必须留下持久可见的状态」那一条：**刷新页面后仍看得出**。
//
// 三件事这张卡都自己负责：
// ① 只在 `acceptedMergeMethod === "no_commit"` 时出现 —— 靠事实列判，不靠
//    `acceptedMergeCommit === null` 去猜（同一个 null 还有「不可知」那层含义）。
// ② 每次都让服务端**核对现场**：那份改动此刻是还躺着、已经被自己提交了、还是被丢了。
// ③ 三种态各给各自的出路，且**动作都由用户自己点**（ash 不替他提交、不强删分支）。
export function PendingMergeCard({ task, notify, onTaskUpdated }: {
  task: TaskListItem | Task;
  notify: (message: string) => void;
  onTaskUpdated?: (task: Task) => void;
}) {
  const applicable = task.acceptedMergeMethod === "no_commit";
  const [state, setState] = useState<PendingMergeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(applicable);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<"commit" | "remerge" | null>(null);
  const [commitChoice, setCommitChoice] = useState<boolean | null>(null);
  const commitDefault = useAcceptCommitDefault(task.projectId, action === "remerge");
  const commitChecked = commitChoice ?? commitDefault.value ?? true;
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  // 依赖里放 `acceptedMergeCommit` 而不是 `updatedAt`：这张卡要跟着「收尾没收尾」变，
  // 跟着每一次任务更新重新跑一遍 git 核对是白烧。
  useEffect(() => {
    if (!applicable) { setState(null); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    api.pendingMerge(task.id).then(
      (result) => { if (alive) { setState(result.state); setError(null); } },
      (reason: unknown) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); },
    ).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [applicable, task.id, task.acceptedMergeCommit, attempt]);

  if (!applicable) return null;

  const refreshTask = async () => {
    if (!onTaskUpdated) return;
    await api.task(task.id).then(onTaskUpdated).catch(() => {});
  };
  const run = async (kind: "commit" | "remerge") => {
    if (busy) return;
    if (kind === "remerge" && commitChoice === null && commitDefault.value === null) return;
    setAction(null);
    setBusy(true);
    try {
      const result = kind === "commit"
        ? await api.commitPendingMerge(task.id)
        // 发的是用户在框里看到的那个值，不让后端再读一次项目设置（与验收那条路同口径）。
        : await api.remergePendingMerge(task.id, commitChoice ?? commitDefault.value ?? undefined);
      setState(result.state);
      notify(result.notices?.length ? `${result.message}（${result.notices.join("；")}）` : result.message);
      await refreshTask();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      notify(message);
      setError(message);
      reload();
    } finally {
      setBusy(false);
    }
  };

  const heading = loading && !state
    ? "正在核对那次合并的现场…"
    : error
      ? "读不到那次合并的现场"
      : !state
        ? "这次验收没有待收尾的合并"
        : state.kind === "staged"
          ? "验收完成，但这次合并还没提交"
          : state.kind === "committed"
            ? "这次合并已经提交，收尾完成"
            : state.kind === "discarded"
              ? "那次合并的改动已经不在了"
              : state.kind === "foreign"
                ? "目标分支的暂存区跟那次合并对不上"
                : "这次合并的现场认不出来";
  const settled = state?.kind === "committed";
  const commands = state && state.kind !== "committed" && state.targetBranch && state.sourceBranch
    ? [
        `git -C ${state.repoPath} commit -m "squash 合并 ${state.sourceBranch}"`,
        `git -C ${state.repoPath} reset --hard`,
      ]
    : [];

  return (
    <section className={`pending-merge-card${settled ? " is-settled" : ""}`} aria-label="待提交的验收合并">
      <header>
        <span>{settled ? <GitCommit size={14} weight="fill" /> : busy || loading ? <SpinnerGap size={14} className="is-spinning" /> : <WarningCircle size={14} weight="fill" />}</span>
        <div>
          <b>{heading}</b>
          {error
            ? <p role="alert">{error}</p>
            : state && <p style={{ whiteSpace: "pre-line" }}>{state.message}</p>}
        </div>
        <button type="button" className="pending-merge-refresh" disabled={busy || loading} onClick={reload}>
          <ArrowClockwise size={12} aria-hidden="true" />重新核对
        </button>
      </header>
      {state?.stagedFiles?.length ? (
        <div className="pending-merge-files">
          <span>待提交的文件（{state.stagedFiles.length}）</span>
          <ul>{state.stagedFiles.slice(0, 40).map((file) => <li key={file}><code>{file}</code></li>)}</ul>
          {state.stagedFiles.length > 40 && <small>只列了前 40 个，共 {state.stagedFiles.length} 个。</small>}
        </div>
      ) : null}
      {state?.dirtyFiles?.length ? (
        <div className="pending-merge-files">
          <span>这些不会被带进提交（没暂存/没跟踪，{state.dirtyFiles.length}）</span>
          <ul>{state.dirtyFiles.slice(0, 20).map((file) => <li key={file}><code>{file}</code></li>)}</ul>
        </div>
      ) : null}
      {commands.length > 0 && (
        <div className="pending-merge-commands">
          <span>也可以自己在终端里收尾（提交 / 丢弃）</span>
          <ul>{commands.map((line) => <li key={line}><code>{line}</code></li>)}</ul>
        </div>
      )}
      {state && (state.canCommit || state.canRemerge) && (
        <div className="pending-merge-actions">
          {state.canCommit && (
            <button type="button" className="is-primary" disabled={busy} onClick={() => setAction("commit")}>
              {busy ? <SpinnerGap size={13} className="is-spinning" /> : <GitCommit size={13} weight="fill" />}现在提交
            </button>
          )}
          {state.canRemerge && (
            <button type="button" disabled={busy} onClick={() => { setCommitChoice(null); setAction("remerge"); }}>
              重新验收（再合一次）
            </button>
          )}
        </div>
      )}
      {action === "commit" && state?.targetBranch && (
        <ConfirmDialog
          title="把这次合并落成提交？"
          message={`这会在 ${state.targetBranch} 上产生一个提交，内容就是上面列出的那些暂存改动，`
            + `提交消息与正常验收一致（squash 合并 ${state.sourceBranch}）。`
            + "动手前会再核对一次索引指纹：对不上就什么都不做并告诉你原因，绝不把无关改动一起提交。"
            + `${state.dirtyFiles?.length ? "这个工作区里没暂存/没跟踪的那些文件不会被带进来。" : ""}`
            + "提交之后会把当初因为「没提交」跳过的分支清理再跑一遍（仍然只用 git branch -d，绝不强删）。"}
          confirmLabel="提交" busy={busy}
          onConfirm={() => void run("commit")} onClose={() => { if (!busy) setAction(null); }}
        />
      )}
      {action === "remerge" && state?.targetBranch && (
        <ConfirmDialog
          title="重新合一次？"
          message={`那次合并的改动已经不在 ${state.targetBranch} 的工作区里了。这会把来源分支 `
            + `${state.sourceBranch} 重新合一次（冲突时只报告并回滚，不强制合并）。`}
          confirmLabel={commitChecked ? "重新合并并提交" : "重新合并（不提交）"} danger busy={busy}
          confirmDisabled={commitDefault.pending}
          onConfirm={() => void run("remerge")} onClose={() => { if (!busy) setAction(null); }}
        >
          <AcceptCommitChoice
            checked={commitChecked}
            projectDefault={commitDefault.value}
            error={commitDefault.error}
            target={state.targetBranch}
            disabled={busy}
            onChange={setCommitChoice}
            onRetry={commitDefault.reload}
          />
        </ConfirmDialog>
      )}
    </section>
  );
}
