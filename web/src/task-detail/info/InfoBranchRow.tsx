// 「信息」格的「分支」那一行，连同没有独立工作区时指到才出现的「改到独立工作区…」。
//
// 点开在这一行底下整行铺开：选起点（本地、远端分两组，也可以手打一个提交）、选合入分支（缺省按起点定），
// 交给服务端办（server/src/task-worktree-move.ts）。办成之后任务行和会话行都改指新工作区，这一行和
// 「目录」「改动」跟着换过来。智能体登记了还没办的那一次，在分支名后淡淡写一句，可以撤回。
import { useEffect, useState } from "react";
import type { Session, Task } from "@navi/shared";
import { ArrowCounterClockwise, GitFork } from "@phosphor-icons/react";
import { Dropdown, type DropdownOption } from "../../components/Dropdown.tsx";
import { HoverTip, useHoverTip } from "../../components/HoverTip.tsx";
import { InspButton, InspCopy, InspRow, InspTool } from "../../inspector/parts.tsx";
import { api } from "../../lib/api.ts";

const BY_BASE = "";

/** 本地、远端两组候选。远端那一组要服务端分支清单里带 `remoteBranches`（从远端分支开工那一版起才有）。 */
async function readBaseOptions(projectId: string): Promise<{ local: string[]; options: DropdownOption[]; current: string | null }> {
  const list = await api.projectBranches(projectId) as { branches: string[]; current: string | null; remoteBranches?: { ref: string }[] };
  const remote = list.remoteBranches ?? [];
  const grouped = remote.length > 0;
  return {
    local: list.branches,
    current: list.current,
    options: [
      ...list.branches.map((branch) => ({ value: branch, label: branch, mono: true, group: grouped ? "本地" : undefined })),
      ...remote.map((branch) => ({ value: branch.ref, label: branch.ref, mono: true, group: "远端" })),
    ],
  };
}

function MoveForm({ task, session, onClose, notify }: {
  task: Task;
  session: Session;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const [refs, setRefs] = useState<Awaited<ReturnType<typeof readBaseOptions>> | null>(null);
  const [base, setBase] = useState(session.branch ?? "");
  const [target, setTarget] = useState(BY_BASE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    readBaseOptions(task.projectId).then(
      (next) => { if (alive) setRefs(next); },
      (reason) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { alive = false; };
  }, [task.projectId]);

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
          options={refs?.options ?? (base ? [{ value: base, label: base, mono: true }] : [])}
          status={refs ? "ready" : error ? "failed" : "loading"}
          allowCustom
          filterPlaceholder="筛选分支，或填一个提交…"
          placeholder="选一个起点"
          mono
          onChange={setBase}
        />
        <span>合入</span>
        <Dropdown
          className="insp-dropdown"
          label="合入分支"
          value={target}
          options={[{ value: BY_BASE, label: "按起点定" }, ...(refs?.local ?? []).map((branch) => ({ value: branch, label: branch, mono: true }))]}
          filterPlaceholder="筛选分支…"
          onChange={setTarget}
        />
      </div>
      {error && <p className="insp-bad insp-move-error" role="alert">{error}</p>}
      <div className="insp-inline-acts">
        <InspButton variant="quiet" size="sm" disabled={busy} onClick={onClose}>取消</InspButton>
        <InspButton variant="pri" size="sm" disabled={busy || !base.trim()} onClick={() => void submit()}>
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
      <span className="insp-faint insp-cut" {...hover.anchorProps} tabIndex={0}>· 待改到 {request.base}</span>
      <HoverTip at={hover.at}>下一回合开头改到独立工作区，从 {request.base} 开出{request.mergeTargetBranch ? `，合入 ${request.mergeTargetBranch}` : ""}</HoverTip>
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
  const [moving, setMoving] = useState(false);
  const branch = session.branch!;
  // 跟服务端 worktreeMoveBlocker 同一组条件：验收合并过的，改动早已落在项目里，不给入口。
  const movable = !task.useWorktree && !task.reviewOf && task.mode === "single" && !task.archived
    && task.stage !== "accepted" && task.stage !== "merged"
    && task.status !== "running" && task.status !== "queued" && !task.worktreeMoveRequest;
  useEffect(() => {
    if (!movable) setMoving(false);
  }, [movable]);
  return (
    <>
      <InspRow label="分支" className={task.useWorktree ? "" : "is-danger"}>
        <span className="insp-has-tip insp-cut" tabIndex={0} {...hover.anchorProps}>{branch}</span>
        <HoverTip at={hover.at}>{task.useWorktree ? branch : `${branch}（没有独立工作区，直接在这条分支上改）`}</HoverTip>
        {task.worktreeMoveRequest && <PendingMove task={task} notify={notify} />}
        <InspCopy text={branch} label="复制分支名" onError={notify} />
        {movable && (
          <InspTool label="改到独立工作区…" className="insp-copy" aria-expanded={moving} onClick={() => setMoving((current) => !current)}>
            <GitFork size={14} aria-hidden="true" />
          </InspTool>
        )}
      </InspRow>
      {moving && movable && <MoveForm task={task} session={session} onClose={() => setMoving(false)} notify={notify} />}
    </>
  );
}
