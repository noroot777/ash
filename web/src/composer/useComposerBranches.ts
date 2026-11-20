import { useEffect, useState } from "react";
import type { ProjectView } from "@navi/shared";
import type { ProjectBranches } from "@navi/shared/task-branch";
import { api } from "../lib/api.ts";
import { projectGitEpoch, readProjectGitRun } from "../workspace/projectGitRuns.ts";
import { useProjectGit } from "../workspace/useProjectGit.ts";

type Branches = ProjectBranches & { projectId: string; epoch: number };

export function useComposerBranches(project: ProjectView, notify: (message: string) => void) {
  const { id: projectId, health: { isRepo } } = project;
  const git = useProjectGit(isRepo ? projectId : null, false);
  const [refs, setRefs] = useState<Branches | null>(null);
  const [selection, setSelection] = useState({ projectId, base: "" });

  useEffect(() => {
    setSelection({ projectId, base: "" });
  }, [projectId]);

  useEffect(() => {
    if (!isRepo) return;
    let alive = true;
    const epoch = projectGitEpoch(projectId);
    const isCurrent = () => alive && epoch === projectGitEpoch(projectId) && !readProjectGitRun(projectId).busy;
    api.projectBranches(projectId).then((next) => {
      if (isCurrent()) setRefs({ projectId, epoch, ...next });
    }).catch((error) => {
      if (isCurrent()) notify(error instanceof Error ? error.message : "分支读取失败");
    });
    return () => { alive = false; };
  }, [projectId, isRepo, git.settled, notify]);

  const loaded = refs?.projectId === projectId ? refs : null;
  const latest = loaded?.epoch === projectGitEpoch(projectId) ? loaded : null;
  const branches = latest?.branches ?? git.state?.branches.map((branch) => branch.name) ?? loaded?.branches ?? [];
  // 远端分支只认分支接口那一份（git 面板的状态里没有）；切过分支之后旧的那份照样能用。
  const remoteBranches = loaded?.remoteBranches ?? [];
  const base = selection.projectId === projectId ? selection.base : "";
  const automaticLabel = "跟随项目分支（创建时确定）";
  const switching = git.busy === "checkout";

  return {
    branches,
    remoteBranches,
    /** 有远端才给「刷新远端分支」：走侧栏分支胶囊同一本账（fetch --prune），落定后上面那趟读自己重来。 */
    refreshRemotes: loaded?.remotes?.length
      ? () => { void git.run("fetch", () => api.projectGitFetch(projectId)); }
      : null,
    fetchingRemotes: git.busy === "fetch",
    base,
    automaticLabel,
    switching,
    isSwitching: () => isRepo && readProjectGitRun(projectId).busy === "checkout",
    setBase: (value: string) => setSelection({ projectId, base: value }),
  };
}
