import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowRight, CaretDown, Check, GitBranch } from "@phosphor-icons/react";
import type { Task, TaskListItem } from "@ash/shared";
import { api, type TaskCommit, type TaskDiffResult } from "../lib/api.ts";
import { openGitWorkbench } from "../git-workbench/navigation.ts";
import { formatInstant } from "../task-detail/utils.ts";
import { useBranchPlan } from "../review/useBranchPlan.ts";
import { AcceptLayer } from "./AcceptLayer.tsx";
import { refreshTaskFacts } from "./taskFacts.ts";

export type RouteData = {
  source: string;
  target: string;
  commits: TaskCommit[];
  diff: TaskDiffResult;
};

const TASK_BRANCH = /^(ash|harness)\//;

/**
 * 第一行左半：任务分支 → 目标分支 · N 提交 · N 文件 +a −d。「我在看谁的什么改动」一句话说完，
 * 下面直接是 diff。
 *
 * 目标分支在没验收之前点得开（换合入目标，带指纹，和服务端「依赖与范围没变」那道校验同一口径）；
 * 验收之后不再能点，后面跟着那次合并的区间（验收时冻结，后来分支再动也不改它）。
 * 「N 提交」点开是提交清单：diff 是分支相对基点的整体改动，不按单个提交切，所以每一条跳去 Git
 * 工作台看它自己的 diff，基点垫在最底下。
 */
export function AcceptRoute({ task, data, disabled, onTaskUpdated, notify }: {
  task: TaskListItem;
  data: RouteData;
  disabled: boolean;
  onTaskUpdated: (task: Task) => void;
  notify: (message: string) => void;
}) {
  const settled = task.stage === "accepted" || task.stage === "merged";
  const plan = useBranchPlan(task, !settled);
  const [layer, setLayer] = useState<"target" | "commits" | null>(null);
  const targetRef = useRef<HTMLButtonElement>(null);
  const commitsRef = useRef<HTMLButtonElement>(null);
  const entry = plan.view?.task ?? null;
  const editable = !settled && !!task.useWorktree && !!entry;
  const locked = disabled || plan.loading || plan.refreshing || !!plan.error || !!task.archived
    || !!entry?.baseUpdatePending || ["running", "queued"].includes(task.status);
  const files = data.diff.files;
  // 数不出来的（二进制、被截断）后端给 null：全都数不出来就照实写「?」，同 diff 文件轨的口径。
  const total = (side: "additions" | "deletions") => files.length && files.every((file) => file[side] == null)
    ? "?" : files.reduce((sum, file) => sum + (file[side] ?? 0), 0);
  const add = total("additions");
  const del = total("deletions");
  const range = task.stage === "accepted" && task.acceptedBaseCommit && task.acceptedMergeCommit
    ? `${task.acceptedBaseCommit.slice(0, 8)}..${task.acceptedMergeCommit.slice(0, 8)}` : null;
  return (
    <div className="acc-route">
      <GitBranch size={14} aria-hidden="true" />
      <code className="acc-src">{data.source}</code>
      <ArrowRight size={12} className="acc-arrow" aria-label="合入" />
      {editable ? (
        <button ref={targetRef} type="button" className="acc-target" aria-haspopup="menu" aria-expanded={layer === "target"}
          aria-label={`合入目标 ${data.target}，点开更换`} disabled={locked}
          onClick={() => setLayer(layer === "target" ? null : "target")}>
          <code>{data.target}</code><CaretDown size={11} aria-hidden="true" />
        </button>
      ) : <code className="acc-dst">{data.target}</code>}
      {range && <code className="acc-range" aria-label={`合并区间 ${range}`}>{range}</code>}
      <button ref={commitsRef} type="button" className="acc-link" aria-expanded={layer === "commits"} disabled={!data.commits.length}
        onClick={() => setLayer(layer === "commits" ? null : "commits")}>{data.commits.length} 提交</button>
      <span className="acc-stat">{files.length} 文件 <b className="acc-add">+{add}</b> <b className="acc-del">−{del}</b></span>
      {layer === "target" && entry && (
        <TargetMenu anchorRef={targetRef} taskId={task.id} projectId={entry.projectId} current={data.target}
          source={entry.sourceBranch ?? data.source} fingerprint={entry.fingerprint} disabled={locked}
          onClose={() => setLayer(null)}
          onChanged={async (branch) => {
            setLayer(null);
            notify(`合入目标已改为 ${branch}`);
            // 改了目标：任务、走向、diff 一起作废重读（refreshTaskFacts），任务没追平之前主按钮锁着 ——
            // 确认层里的目标是从任务推出来的，不能拿旧的那份去确认。
            await Promise.all([plan.refresh(), refreshTaskFacts(task, onTaskUpdated)]);
          }}
          notify={notify} />
      )}
      {layer === "commits" && (
        <AcceptLayer open anchorRef={commitsRef} onClose={() => setLayer(null)} label="提交" className="acc-layer-commits">
          <ul>{data.commits.map((commit) => (
            <li key={commit.sha}>
              <button type="button" aria-label={`在 Git 工作台打开提交 ${commit.sha.slice(0, 8)} ${commit.subject}`}
                onClick={() => openGitWorkbench({ projectId: task.projectId, taskId: task.id, view: "history", commit: commit.sha })}>
                <code>{commit.sha.slice(0, 8)}</code><span>{commit.subject}</span><time>{formatInstant(commit.at)}</time>
              </button>
            </li>
          ))}</ul>
          {data.diff.mergeBase && <p>基点 <code>{data.diff.mergeBase.slice(0, 8)}</code></p>}
        </AcceptLayer>
      )}
    </div>
  );
}

function TargetMenu({ anchorRef, taskId, projectId, current, source, fingerprint, disabled, onClose, onChanged, notify }: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  taskId: string;
  projectId: string;
  current: string;
  source: string;
  /** 打开那一刻的指纹：期间依赖或范围变了，服务端会拒绝，而不是悄悄改到一份没核对过的计划上。 */
  fingerprint: string;
  disabled: boolean;
  onClose: () => void;
  onChanged: (branch: string) => Promise<void>;
  notify: (message: string) => void;
}) {
  const [branches, setBranches] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [snapshot] = useState(fingerprint);
  useEffect(() => {
    let alive = true;
    api.projectBranches(projectId).then(
      (result) => { if (alive) setBranches(result.branches.filter((branch) => branch !== source)); },
      (reason) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { alive = false; };
  }, [projectId, source]);
  const save = async (branch: string) => {
    if (disabled || busy || branch === current) { if (branch === current) onClose(); return; }
    setBusy(true);
    try {
      await api.changeMergeTarget(taskId, branch, snapshot);
      await onChanged(branch);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AcceptLayer open anchorRef={anchorRef} onClose={onClose} label="合入目标" role="menu" className="acc-layer-menu">
      {!branches && !error && <p className="acc-layer-note"><i className="acc-spin is-ink" aria-hidden="true" />读取分支</p>}
      {error && <p className="acc-layer-note is-red">{error}</p>}
      {branches && !branches.length && <p className="acc-layer-note">没有别的本地分支</p>}
      {branches?.map((branch) => (
        <button key={branch} type="button" role="menuitemradio" aria-checked={branch === (picked ?? current)} disabled={busy}
          onClick={() => (TASK_BRANCH.test(branch) && branch !== current ? setPicked(branch) : void save(branch))}>
          <code>{branch}</code>{branch === (picked ?? current) && <Check size={12} aria-hidden="true" />}
        </button>
      ))}
      {picked && (
        <div className="acc-layer-warn" role="status">
          <p>这是一条任务分支。它的工作区还占着时，先在那个任务上释放目录（保留分支），再单独验收这个任务；不能和它一起统一验收。</p>
          <footer>
            <button type="button" className="acc-btn" onClick={() => setPicked(null)}>取消</button>
            <button type="button" className="acc-btn is-primary" disabled={busy} onClick={() => void save(picked)}>
              {busy && <i className="acc-spin" aria-hidden="true" />}改到这里
            </button>
          </footer>
        </div>
      )}
    </AcceptLayer>
  );
}
