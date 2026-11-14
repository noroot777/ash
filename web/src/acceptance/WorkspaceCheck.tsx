import { useEffect, useRef, useState } from "react";
import type { TaskListItem } from "@ash/shared";
import { acceptanceAutoCommitMessage, type AcceptanceAutoCommitOutcome } from "@ash/shared/accept-workspace";
import { api, type ScmOverview } from "../lib/api.ts";
import { announceWorkspaceCommit, workspaceCommitBlock, workspaceCommitPaths } from "../review/workspaceCommit.ts";
import { CheckAction, CheckRow, FileList } from "./CheckRow.tsx";

/** 这一次验收自己顺手做的那次提交（或跳过它的理由）。 */
export function AutoCommitCheck({ outcome }: { outcome: AcceptanceAutoCommitOutcome }) {
  return <CheckRow check="auto-commit" tone={outcome.status === "committed" ? "passed" : outcome.status === "failed" ? "warn" : "idle"} text={acceptanceAutoCommitMessage(outcome)} />;
}

/**
 * 「任务工作区还有没提交的文件」那一行：它们不在任务分支上，不会随合并进去。状态那半句照抄服务端
 * 的预检（验收时会不会替你提交、为什么不会）；拿不准归属、有冲突、有嵌套仓库时「提交」灰着，
 * 原因在展开层里。
 */
export function WorkspaceCommitRow({ overview, busy, disabled = false, error, onCommit }: {
  overview: ScmOverview;
  busy: boolean;
  disabled?: boolean;
  error: string | null;
  onCommit: () => void;
}) {
  const paths = [...new Set([...overview.status.staged, ...overview.status.unstaged, ...overview.status.untracked, ...overview.status.merge]
    .map((change) => change.path))];
  const block = workspaceCommitBlock(overview);
  if (!paths.length && !error) return null;
  const precheck = overview.taskRunning ? "任务还在跑，结束后再提交"
    : overview.acceptanceAutoCommit
      ? `${overview.acceptanceAutoCommit.action === "skip" ? "验收时不会替你提交：" : ""}${overview.acceptanceAutoCommit.reason}`
      : "验收时会不会替你提交还没确认";
  return (
    <CheckRow
      check="workspace"
      tone={error ? "block" : "warn"}
      text={paths.length ? `${paths.length} 个文件未提交` : "正在核对提交结果"}
      state={error ?? precheck}
      detail={(
        <div className="acc-detail-text">
          {block && <p>{block}</p>}
          <p className="mono">{overview.root.path}</p>
          <FileList files={paths} />
        </div>
      )}
      tools={<CheckAction busy={busy} disabled={disabled || !!block || !paths.length} onClick={onCommit}>提交</CheckAction>}
    />
  );
}

export function WorkspaceCheck({ task, notify, disabled = false }: {
  task: TaskListItem;
  notify: (message: string) => void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<{ taskId: string; overview: ScmOverview | null; error: string | null }>({ taskId: task.id, overview: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [commitError, setCommitError] = useState<{ taskId: string; message: string } | null>(null);
  const activeTask = useRef(task.id);
  activeTask.current = task.id;
  useEffect(() => {
    let alive = true;
    const refresh = () => api.taskScm(task.id).then(
      (overview) => { if (alive) setState({ taskId: task.id, overview, error: null }); },
      (error) => {
        if (!alive) return;
        const message = error instanceof Error ? error.message : String(error);
        setState((current) => ({ taskId: task.id, overview: current.taskId === task.id ? current.overview : null,
          error: message.includes("不是 Git 仓库") ? null : message }));
      },
    );
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [task.id, task.updatedAt, attempt]);
  const current = state.taskId === task.id ? state : null;
  const commit = async () => {
    if (busy || disabled) return;
    const taskId = task.id;
    setBusy(true);
    setCommitError(null);
    try {
      // 按下那一刻再读一遍：列在这一行的是 15 秒前的样子。
      const overview = await api.taskScm(taskId);
      const block = workspaceCommitBlock(overview);
      if (block) throw new Error(block);
      const paths = workspaceCommitPaths(overview.status);
      if (!paths.length) { setAttempt((value) => value + 1); return; }
      const result = await api.scmCommit(taskId, `chore: ${task.title.replace(/[\r\n]+/g, " ")}`, { stagePaths: paths, acceptance: true });
      announceWorkspaceCommit(taskId);
      notify(`任务改动已提交${result.sha ? ` · ${result.sha.slice(0, 8)}` : ""}${result.warning ? `；${result.warning}` : ""}${result.note ? `；${result.note}` : ""}`);
    } catch (error) {
      if (activeTask.current === taskId) setCommitError({ taskId, message: error instanceof Error ? error.message : String(error) });
      return;
    } finally {
      if (activeTask.current === taskId) setBusy(false);
    }
    if (activeTask.current === taskId) setAttempt((value) => value + 1);
  };
  if (!current?.overview) {
    return current?.error
      ? <CheckRow check="workspace" tone="block" text="未提交改动读不出来" state={current.error}
        tools={<CheckAction onClick={() => setAttempt((value) => value + 1)}>重试</CheckAction>} />
      : null;
  }
  return <WorkspaceCommitRow overview={current.overview} busy={busy} disabled={disabled}
    error={commitError?.taskId === task.id ? commitError.message : current.error}
    onCommit={() => void commit()} />;
}
