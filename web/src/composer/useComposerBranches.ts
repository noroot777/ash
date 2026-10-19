import { useEffect, useState } from "react";
import type { ProjectView } from "@ash/shared";
import { api } from "../lib/api.ts";
import { projectGitEpoch, readProjectGitRun } from "../workspace/projectGitRuns.ts";
import { useProjectGit } from "../workspace/useProjectGit.ts";

type Branches = { projectId: string; epoch: number; branches: string[]; current: string | null };

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
  const current = latest ? latest.current : git.state?.branch.head ?? null;
  const branches = latest?.branches ?? git.state?.branches.map((branch) => branch.name) ?? loaded?.branches ?? [];
  const base = selection.projectId === projectId ? selection.base : "";
  const automaticLabel = `跟随项目分支 · ${current || "当前 HEAD"}`;
  const switching = git.busy === "checkout";

  return {
    branches,
    base,
    automaticLabel,
    switching,
    isSwitching: () => isRepo && readProjectGitRun(projectId).busy === "checkout",
    setBase: (value: string) => setSelection({ projectId, base: value }),
  };
}
