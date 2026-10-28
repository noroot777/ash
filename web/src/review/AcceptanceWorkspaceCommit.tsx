import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, GitCommit, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import type { TaskListItem } from "@ash/shared";
import { api, type ScmOverview } from "../lib/api.ts";
import { announceWorkspaceCommit, workspaceCommitBlock, workspaceCommitPaths } from "./workspaceCommit.ts";

export function WorkspaceCommitNotice({ overview, autoCommit, busy, error, onCommit, onRefresh }: {
  overview: ScmOverview;
  autoCommit: boolean | null;
  busy: boolean;
  error: string | null;
  onCommit: () => void;
  onRefresh: () => void;
}) {
  const count = new Set([...overview.status.staged, ...overview.status.unstaged, ...overview.status.untracked, ...overview.status.merge]
    .map(change => change.path)).size;
  const block = workspaceCommitBlock(overview);
  if (!count && !error) return null;
  return <section className="accept-workspace-commit" aria-label="未提交改动" role="status">
    <WarningCircle size={17} aria-hidden="true" />
    <div><b>{count ? `任务工作区有 ${count} 个文件尚未提交` : "正在核对提交结果"}</b>
      <p>未提交的改动不在当前提交记录中，也不会随任务分支合入。请先提交，避免遗漏。</p>
      <small>{autoCommit === null ? "自动提交设置尚未读取；可手动提交，或到项目设置 → 验收查看。"
        : autoCommit ? "项目已开启验收前自动提交；点击验收时会先提交这些改动。" : "项目未开启自动提交；可一键提交，或到项目设置 → 验收开启。"}</small>
      <small>一键提交包含此任务工作目录内全部已暂存、未暂存及未跟踪文件，不推送远端。</small>
      <small className="mono">{overview.root.path}</small>
      {block && <p>{block}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
    <div className="accept-workspace-commit-actions">
      <button type="button" disabled={busy || !!block || !count} onClick={onCommit}>
        {busy ? <SpinnerGap size={14} className="is-spinning" /> : <GitCommit size={14} />} {busy ? "提交中…" : "一键提交改动"}
      </button>
      <button type="button" disabled={busy} onClick={onRefresh} aria-label="刷新未提交改动"><ArrowClockwise size={14} /></button>
    </div>
  </section>;
}

export function AcceptanceWorkspaceCommit({ task, notify, disabled = false }: {
  task: TaskListItem;
  notify: (message: string) => void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<{ taskId: string; overview: ScmOverview | null; error: string | null }>({ taskId: task.id, overview: null, error: null });
  const [autoCommit, setAutoCommit] = useState<boolean | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const activeTask = useRef(task.id);
  activeTask.current = task.id;
  useEffect(() => {
    let alive = true;
    setAutoCommit(null);
    api.projects().then(projects => {
      const project = projects.find(project => project.id === task.projectId);
      if (alive && project) setAutoCommit(project.acceptAutoCommit === true);
    }).catch(() => {});
    return () => { alive = false; };
  }, [task.projectId, attempt]);
  useEffect(() => {
    let alive = true;
    const refresh = () => api.taskScm(task.id).then(
      overview => { if (alive) setState({ taskId: task.id, overview, error: null }); },
      error => {
        if (!alive) return;
        const message = error instanceof Error ? error.message : String(error);
        setState(current => ({ taskId: task.id, overview: current.taskId === task.id ? current.overview : null,
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
    try {
      const overview = await api.taskScm(taskId);
      const block = workspaceCommitBlock(overview);
      if (block) throw new Error(block);
      const paths = workspaceCommitPaths(overview.status);
      if (!paths.length) { setAttempt(value => value + 1); return; }
      const result = await api.scmCommit(taskId, `chore: ${task.title.replace(/[\r\n]+/g, " ")}`, { stagePaths: paths });
      announceWorkspaceCommit(taskId);
      notify(`任务改动已提交${result.sha ? ` · ${result.sha.slice(0, 8)}` : ""}${result.warning ? `；${result.warning}` : ""}${result.note ? `；${result.note}` : ""}`);
    } catch (error) {
      if (activeTask.current === taskId) setState(current => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
      return;
    } finally {
      if (activeTask.current === taskId) setBusy(false);
    }
    if (activeTask.current === taskId) setAttempt(value => value + 1);
  };
  if (!current?.overview) return current?.error ? <section className="accept-workspace-commit" role="alert">
    <div><b>未能检查未提交改动</b><p>{current.error}</p></div><button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button>
  </section> : null;
  return <WorkspaceCommitNotice overview={current.overview} autoCommit={autoCommit} busy={busy || disabled} error={current.error}
    onCommit={() => void commit()} onRefresh={() => setAttempt(value => value + 1)} />;
}
