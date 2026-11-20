// 「分支」那一行上的兜底：智能体没用「改到独立工作区」，自己 `git worktree add` 了一个目录在里面干活，
// Navi 不知道 —— 这一行还写着项目目录的分支，「改动」也对不上。服务端从会话里认出那个目录
// （server/src/foreign-worktrees.ts），这里指到这一行才出一颗按钮，提示写在它的指到提示里；点开在这一行底下
// 铺开：哪个目录、分支改成什么名字、合入哪条，确认后交给服务端收编（server/src/task-worktree-adopt.ts）。
// 收编之后任务就开了独立工作区，这颗按钮自然不再出现。
import { useEffect, useState } from "react";
import type { Task } from "@navi/shared";
import { taskBranchName } from "@navi/shared/task-branch";
import { ArrowSquareIn } from "@phosphor-icons/react";
import { Dropdown } from "../../components/Dropdown.tsx";
import { HoverTip, useHoverTip } from "../../components/HoverTip.tsx";
import { InspButton, InspRow, InspTool } from "../../inspector/parts.tsx";
import { api } from "../../lib/api.ts";
import type { ForeignWorktree } from "../../lib/apiWorktreeAdopt.ts";

export type ForeignWorktrees = { worktrees: ForeignWorktree[]; mergeTarget: string | null };

/** 只在任务停着、还没有独立工作区时问；任务行一变（比如刚收编完）重问一遍。 */
export function useForeignWorktrees(task: Task, enabled: boolean): ForeignWorktrees | null {
  const [found, setFound] = useState<ForeignWorktrees | null>(null);
  useEffect(() => {
    if (!enabled) { setFound(null); return; }
    let alive = true;
    void api.foreignWorktrees(task.id).then((next) => { if (alive) setFound(next.worktrees.length ? next : null); });
    return () => { alive = false; };
  }, [task.id, task.updatedAt, enabled]);
  return found;
}

export function AdoptTool({ found, open, onToggle }: { found: ForeignWorktrees; open: boolean; onToggle: () => void }) {
  const [first, ...rest] = found.worktrees;
  const tip = `智能体自己建了工作区 ${first!.seenAs}（分支 ${first!.branch}）${rest.length ? `等 ${found.worktrees.length} 个` : ""}，`
    + "Navi 没管到它：这里的分支和改动对不上。点开收编";
  return (
    <InspTool label="收编智能体自建的工作区…" tip={tip} className="insp-copy" aria-expanded={open} onClick={onToggle}>
      <ArrowSquareIn size={14} aria-hidden="true" />
    </InspTool>
  );
}

export function AdoptForm({ task, found, onClose, notify }: {
  task: Task;
  found: ForeignWorktrees;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const [path, setPath] = useState(found.worktrees[0]!.path);
  const [target, setTarget] = useState(found.mergeTarget ?? "");
  const [branches, setBranches] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hover = useHoverTip();
  useEffect(() => {
    let alive = true;
    api.projectBranches(task.projectId).then((refs) => { if (alive) setBranches(refs.branches); }, () => { if (alive) setBranches([]); });
    return () => { alive = false; };
  }, [task.projectId]);
  const worktree = found.worktrees.find((candidate) => candidate.path === path) ?? found.worktrees[0]!;
  const ours = taskBranchName(task.id);
  const targets = (branches ?? (target ? [target] : [])).filter((branch) => branch !== worktree.branch);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { adopted } = await api.adoptWorktree(task.id, worktree.path, target || null);
      notify(`已收编到 ${adopted.branch}`);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <InspRow wide>
      <div className="insp-move-grid">
        <span>目录</span>
        {found.worktrees.length > 1 ? (
          <Dropdown
            className="insp-dropdown"
            label="目录"
            value={worktree.path}
            options={found.worktrees.map((candidate) => ({ value: candidate.path, label: candidate.seenAs, mono: true }))}
            mono
            onChange={setPath}
          />
        ) : (
          <>
            <span className="insp-has-tip insp-cut" tabIndex={0} {...hover.anchorProps}>{worktree.seenAs}</span>
            <HoverTip at={hover.at}>{worktree.seenAs}</HoverTip>
          </>
        )}
        <span>分支</span>
        <span className="insp-cut">{worktree.branch === ours ? ours : `${worktree.branch} → ${ours}`}</span>
        <span>合入</span>
        <Dropdown
          className="insp-dropdown"
          label="合入分支"
          value={target}
          options={targets.map((branch) => ({ value: branch, label: branch, mono: true }))}
          status={branches ? "ready" : "loading"}
          filterPlaceholder="筛选分支…"
          placeholder="选一条合入分支"
          mono
          onChange={setTarget}
        />
      </div>
      {(error ?? worktree.blocker) && <p className="insp-bad insp-move-error" role="alert">{error ?? worktree.blocker}</p>}
      <div className="insp-inline-acts">
        <InspButton variant="quiet" size="sm" disabled={busy} onClick={onClose}>取消</InspButton>
        <InspButton variant="pri" size="sm" disabled={busy || !target || !!worktree.blocker} onClick={() => void submit()}>
          {busy ? "正在收编…" : "收编"}
        </InspButton>
      </div>
    </InspRow>
  );
}
