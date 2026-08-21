import { useMemo, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { ProjectView } from "@ash/shared";
import { GitBranch, GitCommit, TreeStructure, Warning } from "@phosphor-icons/react";
import { api, type GitOverview, type ProjectGitBranchRow } from "../lib/api.ts";
import { useProjectGit } from "../workspace/useProjectGit.ts";
import { ProjectGitActions } from "../workspace/ProjectGitActions.tsx";
import { ProjectGitBranchList } from "../workspace/ProjectGitBranchList.tsx";
import { branchLabel, dirtyText } from "../workspace/projectGitModel.ts";

export function GitProjectStep({
  projects,
  active,
  onChoose,
  onHover,
}: {
  projects: ProjectView[];
  active: number;
  onChoose: (projectId: string) => void;
  onHover: (index: number, event: ReactMouseEvent) => void;
}) {
  return (
    <div className="p-1">
      <div className="palette-label">选择 Git 项目</div>
      {projects.map((project, index) => (
        <button
          key={project.id}
          type="button"
          aria-selected={active === index}
          onMouseMove={(event) => onHover(index, event)}
          onClick={() => onChoose(project.id)}
          className="ui-selectable flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none"
        >
          <GitBranch size={17} className="shrink-0 text-accent" />
          <span className="min-w-0">
            <span className="block truncate text-sm text-ink">{project.name}</span>
            <span className="mt-0.5 block truncate font-mono text-[11px] text-faint">{project.repoPath}</span>
          </span>
        </button>
      ))}
      {!projects.length && <p className="palette-empty">还没有可查看的项目</p>}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="min-h-0 min-w-0 overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h3 className="text-[9px] font-bold uppercase tracking-[0.08em] text-faint">{title}</h3>
        <span className="rounded-full bg-overlay px-1.5 py-0.5 text-[9px] tabular-nums text-muted">{count}</span>
      </div>
      <div className="p-2">{children}</div>
    </section>
  );
}

// `/git` 这一屏以前只能看：分支列出来，点不动。现在它跟侧栏那颗分支胶囊是同一套东西——
// 同一份 `useProjectGit` 数据、同一组按钮、同一套「为什么这条切不过去」的措辞。命令面板
// 只是把它摊成两栏，多给一列 worktree 概览。
export function GitOverviewPanel({
  project,
  projectId,
  overview,
  loading,
  error,
  onChanged,
}: {
  project: ProjectView | undefined;
  projectId: string | null;
  overview: GitOverview | null;
  loading: boolean;
  error: string | null;
  /** 主仓被改过了：让上层重拉一遍 worktree 概览。 */
  onChanged: () => void;
}) {
  const git = useProjectGit(projectId, !!projectId);
  const { state } = git;

  // 分支清单优先用带 upstream / 占用信息的那份；它还没到时，先拿只读概览里的分支名撑住，
  // 免得这一栏在打开的头几百毫秒里是空的。
  const rows = useMemo<ProjectGitBranchRow[]>(() => {
    if (state?.branches.length) return state.branches;
    return (overview?.branches ?? []).map((name) => ({
      name,
      current: name === overview?.current,
      upstream: null,
      ahead: null,
      behind: null,
      gone: false,
      worktree: null,
    }));
  }, [overview, state]);

  const checkout = async (branch: string) => {
    if (!projectId) return;
    if (await git.run("checkout", () => api.projectGitCheckout(projectId, branch))) onChanged();
  };

  if (loading) return <p className="palette-empty">正在读取仓库状态…</p>;
  if (error) return <p className="palette-empty text-red">{error}</p>;
  if (!overview || !projectId) return null;

  const dirty = dirtyText(state);

  return (
    <div className="flex h-[min(58vh,520px)] min-h-[320px] flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
        <GitBranch size={14} className="shrink-0 text-faint" />
        <span className="min-w-0 truncate font-mono text-xs text-ink">{branchLabel(state)}</span>
        {state?.branch.upstream && (
          <span className="shrink-0 text-[10px] text-faint">
            {state.branch.upstream}
            {(state.branch.ahead ?? 0) > 0 && <span className="ml-1 text-muted">↑{state.branch.ahead}</span>}
            {(state.branch.behind ?? 0) > 0 && <span className="ml-1 text-muted">↓{state.branch.behind}</span>}
          </span>
        )}
        <span className="ml-auto shrink-0">
          <ProjectGitActions projectId={projectId} git={git} onChanged={onChanged} />
        </span>
      </div>

      {(state?.operation || dirty || git.error || git.message) && (
        <div className="shrink-0 space-y-1 border-b border-line px-4 py-2 text-[11px]">
          {state?.operation && (
            <p className="flex items-center gap-1.5 text-amber">
              <Warning size={12} weight="fill" className="shrink-0" />
              仓库停在 {state.operation} 中途，先到终端把它收尾或 abort。
            </p>
          )}
          {dirty && <p className="text-muted">主仓有改动：{dirty}</p>}
          {git.error && <p className="text-red">{git.error}</p>}
          {git.message && !git.error && <p className="text-muted">{git.message}</p>}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[38%_62%] divide-x divide-line">
        <Section title="本地分支" count={rows.length}>
          <ProjectGitBranchList
            rows={rows}
            state={state}
            busy={git.busy === "checkout"}
            loading={git.loading}
            roomy
            onCheckout={(branch) => void checkout(branch)}
          />
        </Section>

        <Section title="Worktrees" count={overview.worktrees.length}>
          <div className="space-y-1.5">
            {overview.worktrees.map((worktree) => (
              <div key={worktree.path} className="rounded-lg border border-line bg-raised/45 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <TreeStructure size={14} className="shrink-0 text-accent" />
                  <span className="min-w-0 truncate font-mono text-xs text-ink">{worktree.path}</span>
                </div>
                <div className="mt-2 flex min-w-0 items-center gap-3 pl-[22px] text-[10px] text-faint">
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
              </div>
            ))}
            {!overview.worktrees.length && <p className="px-2.5 py-6 text-center text-xs text-faint">未发现 worktree</p>}
          </div>
        </Section>
      </div>

      <p className="shrink-0 border-t border-line px-4 py-2 text-[10px] leading-relaxed text-faint">
        这里改的是项目主仓，所有任务共用它：切换分支会改变新建任务的默认 base 分支。已经建好的 worktree 不受影响。
        {project && <span className="sr-only">{project.name}</span>}
      </p>
    </div>
  );
}

