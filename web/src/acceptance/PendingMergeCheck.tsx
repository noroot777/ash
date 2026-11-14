import { useCallback, useEffect, useState } from "react";
import type { PendingMergeState } from "@ash/shared/accept-pending";
import type { Task, TaskListItem } from "@ash/shared";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { CheckAction, CheckRow, FileList } from "./CheckRow.tsx";
import { useAcceptCommitDefault } from "./useAcceptCommitDefault.ts";

/**
 * 「合并后不提交」那一档验收完、还欠一步提交的那一行。
 *
 * 只认事实列 `acceptedMergeMethod === "no_commit"`（不拿 `acceptedMergeCommit === null` 去猜），
 * 每次都让服务端**核对现场**：改动还躺着、已经提交了、还是被丢了。提交之后这一行就没了；任务头上
 * 那颗「待提交」徽记是刷新后仍看得出欠一步的那一处（对话区不另铺一张卡）。
 * 动作都由用户自己点：ash 不替他提交、不强删分支。
 */
export function PendingMergeCheck({ task, notify, onTaskUpdated }: {
  task: TaskListItem | Task;
  notify: (message: string) => void;
  onTaskUpdated?: (task: Task) => void;
}) {
  const applicable = task.acceptedMergeMethod === "no_commit";
  const [state, setState] = useState<PendingMergeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<"commit" | "remerge" | null>(null);
  const [commitChoice, setCommitChoice] = useState<boolean | null>(null);
  const commitDefault = useAcceptCommitDefault(task.projectId, action === "remerge");
  const commitChecked = commitChoice ?? commitDefault.value ?? true;
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  // 跟着「收尾没收尾」变（acceptedMergeCommit），不跟着每一次任务更新重跑一遍 git 核对。
  useEffect(() => {
    if (!applicable) { setState(null); return; }
    let alive = true;
    api.pendingMerge(task.id).then(
      (result) => { if (alive) { setState(result.state); setError(null); } },
      (reason: unknown) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { alive = false; };
  }, [applicable, task.id, task.acceptedMergeCommit, attempt]);

  if (!applicable) return null;
  if (error && !state) {
    return <CheckRow check="pending-merge" tone="block" text="读不到那次合并的现场" state={error}
      tools={<CheckAction onClick={reload}>重试</CheckAction>} />;
  }
  if (!state || state.kind === "committed") return null;

  const run = async (kind: "commit" | "remerge") => {
    if (busy) return;
    if (kind === "remerge" && commitChoice === null && commitDefault.value === null) return;
    setAction(null);
    setBusy(true);
    try {
      const result = kind === "commit"
        ? await api.commitPendingMerge(task.id)
        // 发的是框里看到的那个值，不让后端再读一次项目设置（与验收同口径）。
        : await api.remergePendingMerge(task.id, commitChoice ?? commitDefault.value ?? undefined);
      setState(result.state);
      setError(null);
      notify(result.notices?.length ? `${result.message}（${result.notices.join("；")}）` : result.message);
      if (onTaskUpdated) await api.task(task.id).then(onTaskUpdated).catch(() => {});
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
      reload();
    } finally {
      setBusy(false);
    }
  };

  const target = state.targetBranch ?? "目标分支";
  const staged = state.stagedFiles?.length ?? 0;
  const text = state.kind === "staged" ? "合并结果还没提交"
    : state.kind === "discarded" ? "那次合并的改动已经不在了"
      : state.kind === "foreign" ? <>暂存区跟那次合并对不上</>
        : "认不出那次合并的现场";
  const commands = state.sourceBranch && state.targetBranch
    ? [`git -C ${state.repoPath} commit -m "squash 合并 ${state.sourceBranch}"`, `git -C ${state.repoPath} reset --hard`]
    : [];
  return (
    <>
      <CheckRow
        check="pending-merge"
        tone="warn"
        text={text}
        state={state.kind === "staged" && staged ? <>{staged} 个文件暂存在 <code>{target}</code></> : <code>{target}</code>}
        detail={(
          <div className="acc-detail-text">
            <p>{state.message}</p>
            {staged > 0 && <><h4>待提交</h4><FileList files={state.stagedFiles!} /></>}
            {state.dirtyFiles?.length ? <><h4>不会带进提交</h4><FileList files={state.dirtyFiles} limit={20} /></> : null}
            {commands.length > 0 && <><h4>也可以在终端里提交或丢弃</h4><FileList files={commands} /></>}
          </div>
        )}
        tools={state.canCommit
          ? <CheckAction busy={busy} onClick={() => setAction("commit")}>提交</CheckAction>
          : state.canRemerge
            ? <CheckAction busy={busy} onClick={() => { setCommitChoice(null); setAction("remerge"); }}>重新合一次</CheckAction>
            : undefined}
      />
      {action === "commit" && (
        <ConfirmDialog
          title="把这次合并落成提交？"
          message={`在 ${target} 上提交暂存的这些改动（squash 合并 ${state.sourceBranch}）。索引对不上就什么都不做；`
            + "没暂存、没跟踪的文件不会带进来。提交后会把分支清理再跑一遍（只用 git branch -d）。"}
          confirmLabel="提交" busy={busy}
          onConfirm={() => void run("commit")} onClose={() => { if (!busy) setAction(null); }}
        />
      )}
      {action === "remerge" && (
        <ConfirmDialog
          title="重新合一次？"
          message={`把 ${state.sourceBranch} 重新合进 ${target}。冲突时只报告并回滚，不强制合并。`}
          confirmLabel={commitChecked ? "重新合并并提交" : "重新合并，不提交"} danger busy={busy}
          confirmDisabled={commitDefault.pending}
          onConfirm={() => void run("remerge")} onClose={() => { if (!busy) setAction(null); }}
        >
          {commitDefault.value === null
            ? <p role={commitDefault.error ? "alert" : "status"}>
              {commitDefault.error ? <>项目默认读不出来：{commitDefault.error} <button type="button" className="acc-link" onClick={commitDefault.reload}>重试</button></>
                : "正在读项目默认…"}
            </p>
            : <label className="acc-inline-check">
              <input type="checkbox" checked={commitChecked} disabled={busy} onChange={(event) => setCommitChoice(event.target.checked)} />
              合并后提交
            </label>}
        </ConfirmDialog>
      )}
    </>
  );
}
