import type { MouseEvent as ReactMouseEvent } from "react";
import type { ProjectView } from "@harness/shared";
import { Check, GitBranch, GitCommit, TreeStructure } from "@phosphor-icons/react";
import type { GitOverview } from "./api";

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
    <div className="py-1">
      <div className="px-4 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-faint">选择 Git 项目</div>
      {projects.map((project, index) => (
        <button
          key={project.id}
          onMouseMove={(event) => onHover(index, event)}
          onClick={() => onChoose(project.id)}
          className={`flex w-full items-center gap-3 px-4 py-2.5 text-left outline-none ${active === index ? "bg-overlay" : ""}`}
        >
          <GitBranch size={17} className="shrink-0 text-accent" />
          <span className="min-w-0">
            <span className="block truncate text-sm text-ink">{project.name}</span>
            <span className="mt-0.5 block truncate font-mono text-[11px] text-faint">{project.repoPath}</span>
          </span>
        </button>
      ))}
      {!projects.length && <p className="px-4 py-8 text-center text-xs text-faint">还没有可查看的项目</p>}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="min-h-0 min-w-0 overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h3 className="text-[10px] font-medium uppercase tracking-wide text-faint">{title}</h3>
        <span className="rounded-full bg-overlay px-1.5 py-0.5 text-[10px] tabular-nums text-muted">{count}</span>
      </div>
      <div className="p-2">{children}</div>
    </section>
  );
}

export function GitOverviewPanel({
  project,
  overview,
  loading,
  error,
}: {
  project: ProjectView | undefined;
  overview: GitOverview | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) return <p className="px-4 py-12 text-center text-xs text-faint">正在读取仓库状态…</p>;
  if (error) return <p className="px-4 py-12 text-center text-xs text-red-400">{error}</p>;
  if (!overview) return null;

  return (
    <div className="grid h-[50vh] min-h-[320px] grid-cols-[38%_62%] divide-x divide-line">
      <Section title="本地分支" count={overview.branches.length}>
        <div className="space-y-0.5">
          {overview.branches.map((branch) => {
            const current = branch === overview.current;
            return (
              <div key={branch} className={`flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2 ${current ? "bg-accent/10" : ""}`}>
                {current ? <Check size={13} weight="bold" className="shrink-0 text-accent" /> : <GitBranch size={13} className="shrink-0 text-faint" />}
                <span className={`min-w-0 truncate font-mono text-xs ${current ? "font-medium text-accent" : "text-muted"}`}>{branch}</span>
                {current && <span className="ml-auto shrink-0 text-[10px] text-accent/75">当前</span>}
              </div>
            );
          })}
          {!overview.branches.length && <p className="px-2.5 py-6 text-center text-xs text-faint">未发现本地分支</p>}
        </div>
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
      {project && <span className="sr-only">{project.name}</span>}
    </div>
  );
}
