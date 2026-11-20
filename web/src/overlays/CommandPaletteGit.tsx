import { openGitWorkbench } from "../git-workbench/navigation.ts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProjectView } from "@navi/shared";
import { ArrowsClockwise, Check, GitBranch, GitCommit, TreeStructure } from "@phosphor-icons/react";
import { api, type GitOverview } from "../lib/api.ts";
import { readProjectGitRun } from "../workspace/projectGitRuns.ts";
import { useProjectGit } from "../workspace/useProjectGit.ts";

export function GitProjectStep({
  projects,
  active,
  onChoose,
}: {
  projects: ProjectView[];
  active: number;
  onChoose: (projectId: string) => void;
}) {
  return (
    <div className="p-1">
      <div className="palette-label">选择 Git 项目</div>
      {projects.map((project, index) => (
        <button
          key={project.id}
          type="button"
          aria-selected={active === index}
          data-palette-index={index}
          onClick={() => onChoose(project.id)}
          className="ui-selectable flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none"
        >
          <GitBranch size={17} className="shrink-0 text-muted" />
          <span className="min-w-0">
            <span className="block truncate text-sm text-ink">{project.name}</span>
            <span className="mt-0.5 block truncate font-mono text-[length:var(--t-xs)] text-faint">{project.repoPath}</span>
          </span>
        </button>
      ))}
      {!projects.length && <p className="palette-empty">还没有可查看的项目</p>}
    </div>
  );
}

function Section({ title, count, action, children }: { title: string; count: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-h-0 min-w-0 overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h3 className="text-[length:var(--t-xs)] font-medium uppercase tracking-[0.08em] text-faint">{title}</h3>
        <span className="rounded-full bg-overlay px-1.5 py-0.5 text-[length:var(--t-xs)] tabular-nums text-muted">{count}</span>
        {action}
      </div>
      <div className="p-2">{children}</div>
    </section>
  );
}

/**
 * 远端分支那一栏的刷新：只为了看到协作者刚推上去的分支（新建任务要从它开工）。走侧栏分支胶囊同一本账
 * （fetch --prune），不是另一套操作；成了就在原地换上新的概览。
 */
function RemoteRefresh({ projectId, onOverview }: { projectId: string; onOverview: (projectId: string, next: GitOverview) => void }) {
  const git = useProjectGit(projectId, false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(projectId);
  useEffect(() => { current.current = projectId; setError(null); }, [projectId]);
  const refresh = async () => {
    const ok = await git.run("fetch", () => api.projectGitFetch(projectId));
    if (current.current !== projectId) return;
    if (!ok) { setError(readProjectGitRun(projectId).error ?? "刷新远端分支失败"); return; }
    await api.projectGitOverview(projectId).then(
      (next) => { if (current.current === projectId) { setError(null); onOverview(projectId, next); } },
      (reason: unknown) => {
        if (current.current === projectId) setError(`远端已经拉到，但重读失败：${reason instanceof Error ? reason.message : String(reason)}`);
      },
    );
  };
  const fetching = git.busy === "fetch";
  return (
    <span className="ml-auto flex min-w-0 items-center gap-2">
      {error && <span className="min-w-0 truncate text-[length:var(--t-xs)] text-red">{error}</span>}
      <button type="button" className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[length:var(--t-xs)] text-muted hover:bg-overlay hover:text-ink disabled:opacity-60"
        disabled={fetching} onClick={() => { void refresh(); }}>
        <ArrowsClockwise size={11} />
        {fetching ? "正在刷新…" : "刷新"}
      </button>
    </span>
  );
}

// `/git` 这一屏**只读**（用户 2026-08-21 指定）：切分支 / 更新 / 拉取 / 推送只有一个入口，
// 就是侧栏项目名底下那颗分支胶囊。命令面板是「查一眼」的地方，不在这儿开第二个操作面 ——
// 唯一的例外是远端分支那一栏的「刷新」（RemoteRefresh），它只为了把清单读新。
export function GitOverviewPanel({
  project,
  overview,
  loading,
  error,
  onOverview,
}: {
  project: ProjectView | undefined;
  overview: GitOverview | null;
  loading: boolean;
  error: string | null;
  onOverview: (projectId: string, next: GitOverview) => void;
}) {
  if (loading) return <p className="palette-empty">正在读取仓库状态…</p>;
  if (error) return <p className="palette-empty text-red">{error}</p>;
  if (!overview) return null;

  return (
    <div className="grid h-[min(58vh,520px)] min-h-[320px] grid-cols-[38%_62%] divide-x divide-line">
      <div className="flex min-h-0 min-w-0 flex-col divide-y divide-line">
      <Section title="本地分支" count={overview.branches.length}>
        <div className="space-y-0.5">
          {overview.branches.map((branch) => {
            const current = branch === overview.current;
            return (
              <button type="button" onClick={() => { if (project) openGitWorkbench({ projectId: project.id, view: "branches", ref: branch }); }} key={branch} className={`flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2 ${current ? "bg-ink/5" : ""}`}>
                {current ? <Check size={13} weight="bold" className="shrink-0 text-ink" /> : <GitBranch size={13} className="shrink-0 text-faint" />}
                <span className={`min-w-0 truncate font-mono text-xs ${current ? "font-medium text-ink" : "text-muted"}`}>{branch}</span>
                {current && <span className="ml-auto shrink-0 text-[length:var(--t-xs)] text-muted">当前</span>}
              </button>
            );
          })}
          {!overview.branches.length && <p className="px-2.5 py-6 text-center text-xs text-faint">未发现本地分支</p>}
        </div>
      </Section>
      {(overview.remotes?.length > 0 || overview.remoteBranches?.length > 0) && (
        <Section title="远端分支" count={overview.remoteBranches?.length ?? 0}
          action={project && overview.remotes?.length > 0 ? <RemoteRefresh projectId={project.id} onOverview={onOverview} /> : undefined}>
          <div className="space-y-0.5">
            {(overview.remoteBranches ?? []).map((branch) => (
              <button type="button" onClick={() => { if (project) openGitWorkbench({ projectId: project.id, view: "branches", ref: branch.ref }); }} key={branch.ref} className="flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-2">
                <GitBranch size={13} className="shrink-0 text-faint" />
                <span className="min-w-0 truncate font-mono text-xs text-muted">{branch.ref}</span>
              </button>
            ))}
          </div>
        </Section>
      )}
      </div>

      <Section title="Worktrees" count={overview.worktrees.length}>
        <div className="space-y-1.5">
          {overview.worktrees.map((worktree) => (
            <button type="button" onClick={() => { if (project) openGitWorkbench({ projectId: project.id, view: "worktrees", root: worktree.path }); }} key={worktree.path} className="w-full text-left rounded-lg border border-line bg-raised/45 px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <TreeStructure size={14} className="shrink-0 text-muted" />
                <span className="min-w-0 truncate font-mono text-xs text-ink">{worktree.path}</span>
              </div>
              <div className="mt-2 flex min-w-0 items-center gap-3 pl-[22px] text-[length:var(--t-xs)] text-faint">
                <span className="flex min-w-0 items-center gap-1">
                  <GitBranch size={11} />
                  <span className="truncate">{worktree.branch ?? (worktree.detached ? "detached HEAD" : "无分支")}</span>
                </span>
                {worktree.head && (
                  <span className="flex shrink-0 items-center gap-1 font-mono">
                    <GitCommit size={11} /> {worktree.head.slice(0, 8)}
                  </span>
                )}
              </div>
            </button>
          ))}
          {!overview.worktrees.length && <p className="px-2.5 py-6 text-center text-xs text-faint">未发现 worktree</p>}
        </div>
      </Section>
      {project && <span className="sr-only">{project.name}</span>}
    </div>
  );
}
