// 「信息」格的「分支」那一行，连同没有独立工作区时指到才出现的「改到独立工作区…」。
//
// 点开在这一行底下整行铺开：选起点（本地、远端分两组，也可以手打一个提交；下拉底下能刷新远端分支）、
// 选合入分支（缺省按起点定：远端分支合进本地同名分支，本地没有就照远端建一条），交给服务端办
// （server/src/task-worktree-move.ts，起点规则跟新建任务同一份）。办成之后任务行和会话行都改指新工作区，
// 这一行和「目录」「改动」跟着换过来。智能体登记了还没办的那一次，在分支名后淡淡写一句，可以撤回。
// 智能体没走这条路、自己建了 worktree 的，旁边另有一颗「收编」（InfoAdoptWorktree.tsx）。
import { useEffect, useState } from "react";
import type { Session, Task } from "@navi/shared";
import type { ProjectBranches } from "@navi/shared/task-branch";
import { ArrowCounterClockwise, GitFork } from "@phosphor-icons/react";
import { Dropdown } from "../../components/Dropdown.tsx";
import { HoverTip, useHoverTip } from "../../components/HoverTip.tsx";
import { InspButton, InspCopy, InspRow, InspTool } from "../../inspector/parts.tsx";
import { api } from "../../lib/api.ts";
import { useProjectGit } from "../../workspace/useProjectGit.ts";
import { AdoptForm, AdoptTool, useForeignWorktrees } from "./InfoAdoptWorktree.tsx";

const BY_BASE = "";
const shortRef = (ref: string) => ref.replace(/^refs\/remotes\//, "");

/**
 * 项目的本地、远端分支，跟新建面板读的是同一份（useComposerBranches）。刷新远端走项目 git 那本账（fetch），
 * 落定之后这里自己重读一遍。
 */
function useMoveBranches(projectId: string) {
  const git = useProjectGit(projectId, false);
  const [refs, setRefs] = useState<ProjectBranches | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.projectBranches(projectId).then(
      (next) => { if (alive) { setRefs(next); setError(null); } },
      (reason) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { alive = false; };
  }, [projectId, git.settled]);
  const refresh = refs?.remotes.length ? () => { void git.run("fetch", () => api.projectGitFetch(projectId)); } : null;
  return { refs, error, refresh, fetching: git.busy === "fetch" };
}

function MoveForm({ task, session, onClose, notify }: {
  task: Task;
  session: Session;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const { refs, error: readError, refresh, fetching } = useMoveBranches(task.projectId);
  const [base, setBase] = useState(session.branch ?? "");
  const [target, setTarget] = useState(BY_BASE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const local = refs?.branches ?? [];
  const remote = refs?.remoteBranches ?? [];
  const grouped = remote.length > 0;
  // 远端分支发完整引用：短名 `origin/foo` 会被同名 tag 抢先解析（RemoteBranch.fullRef）。
  const baseOptions = [
    ...local.map((branch) => ({ value: branch, label: branch, mono: true, group: grouped ? "本地" : undefined })),
    ...remote.map((branch) => ({ value: branch.fullRef, label: branch.ref, mono: true, group: "远端" })),
  ];
  const remoteBase = local.includes(base) ? null : remote.find((branch) => branch.fullRef === base) ?? null;
  const byBase = remoteBase
    ? local.includes(remoteBase.branch) ? `按起点定：${remoteBase.branch}` : `按起点定：${remoteBase.branch}（新建，跟踪 ${remoteBase.ref}）`
    : "按起点定";

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { moved } = await api.moveToWorktree(task.id, base, target || null);
      notify(`已改到独立工作区 ${moved.branch}`);
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
        <span>起点</span>
        <Dropdown
          className="insp-dropdown"
          label="起点"
          value={base}
          options={refs ? baseOptions : base ? [{ value: base, label: base, mono: true }] : []}
          status={refs ? "ready" : readError ? "failed" : "loading"}
          allowCustom
          filterPlaceholder="筛选分支，或填一个提交…"
          placeholder="选一个起点"
          mono
          onChange={setBase}
          footerAction={refresh ? { label: fetching ? "正在刷新远端分支…" : "刷新远端分支", onClick: refresh, disabled: fetching } : undefined}
        />
        <span>合入</span>
        <Dropdown
          className="insp-dropdown"
          label="合入分支"
          value={target}
          options={[{ value: BY_BASE, label: byBase, mono: !!remoteBase }, ...local.map((branch) => ({ value: branch, label: branch, mono: true }))]}
          filterPlaceholder="筛选分支…"
          onChange={setTarget}
        />
      </div>
      {(error ?? readError) && <p className="insp-bad insp-move-error" role="alert">{error ?? readError}</p>}
      <div className="insp-inline-acts">
        <InspButton variant="quiet" size="sm" disabled={busy} onClick={onClose}>取消</InspButton>
        <InspButton variant="pri" size="sm" disabled={busy || fetching || !base.trim()} onClick={() => void submit()}>
          {busy ? "正在改…" : "改到独立工作区"}
        </InspButton>
      </div>
    </InspRow>
  );
}

/** 智能体登记了、还没办的那一次：分支名后淡淡一句，旁边一颗撤回。 */
function PendingMove({ task, notify }: { task: Task; notify: (message: string) => void }) {
  const hover = useHoverTip();
  const request = task.worktreeMoveRequest!;
  return (
    <>
      <span className="insp-faint insp-cut" {...hover.anchorProps} tabIndex={0}>· 待改到 {shortRef(request.base)}</span>
      <HoverTip at={hover.at}>下一回合开头改到独立工作区，从 {shortRef(request.base)} 开出{request.mergeTargetBranch ? `，合入 ${request.mergeTargetBranch}` : ""}</HoverTip>
      <InspTool
        label="撤回改到独立工作区"
        className="insp-copy"
        onClick={() => void api.cancelWorktreeMove(task.id).then(() => notify("已撤回"), (reason) => notify(reason instanceof Error ? reason.message : String(reason)))}
      >
        <ArrowCounterClockwise size={14} aria-hidden="true" />
      </InspTool>
    </>
  );
}

export function InfoBranchRow({ task, session, notify }: { task: Task; session: Session; notify: (message: string) => void }) {
  const hover = useHoverTip();
  const [open, setOpen] = useState<"move" | "adopt" | null>(null);
  const branch = session.branch!;
  // 跟服务端 worktreeMoveBlocker 同一组条件：验收合并过的，改动早已落在项目里，不给入口。
  const movable = !task.useWorktree && !task.reviewOf && task.mode === "single" && !task.archived
    && task.stage !== "accepted" && task.stage !== "merged"
    && task.status !== "running" && task.status !== "queued" && !task.worktreeMoveRequest;
  const foreign = useForeignWorktrees(task, movable);
  useEffect(() => {
    if (!movable) setOpen(null);
  }, [movable]);
  const toggle = (which: "move" | "adopt") => setOpen((current) => current === which ? null : which);
  return (
    <>
      <InspRow label="分支" className={task.useWorktree ? "" : "is-danger"}>
        <span className="insp-has-tip insp-cut" tabIndex={0} {...hover.anchorProps}>{branch}</span>
        <HoverTip at={hover.at}>{task.useWorktree ? branch : `${branch}（没有独立工作区，直接在这条分支上改）`}</HoverTip>
        {task.worktreeMoveRequest && <PendingMove task={task} notify={notify} />}
        <InspCopy text={branch} label="复制分支名" onError={notify} />
        {movable && foreign && <AdoptTool found={foreign} open={open === "adopt"} onToggle={() => toggle("adopt")} />}
        {movable && (
          <InspTool label="改到独立工作区…" className="insp-copy" aria-expanded={open === "move"} onClick={() => toggle("move")}>
            <GitFork size={14} aria-hidden="true" />
          </InspTool>
        )}
      </InspRow>
      {open === "move" && movable && <MoveForm task={task} session={session} onClose={() => setOpen(null)} notify={notify} />}
      {open === "adopt" && movable && foreign && <AdoptForm task={task} found={foreign} onClose={() => setOpen(null)} notify={notify} />}
    </>
  );
}
