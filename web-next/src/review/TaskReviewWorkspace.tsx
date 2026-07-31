import { useEffect, useState } from "react";
import type { Task } from "@harness/shared";
import { taskDisplayStatus } from "@harness/shared";
import {
  CaretDown,
  GitBranch,
  GitCommit,
  SpinnerGap,
  X,
} from "@phosphor-icons/react";
import { LegacyLink } from "../components/LegacyLink.tsx";
import { api, type TaskCommit, type TaskDiffResult } from "../lib/api.ts";
import { MessageAttachments } from "../task-detail/Attachments.tsx";
import { AcceptanceControls } from "../team/TeamReviewWorkspace.tsx";
import { ReviewEvidence } from "../team/ReviewEvidence.tsx";
import { formatInstant, parseAttachmentText } from "../task-detail/utils.ts";
import { ReviewDiffViewer } from "./ReviewDiffViewer.tsx";
import { sharedTeamParent } from "./reviewModel.ts";

type ReviewData = {
  branch: string | null;
  commits: TaskCommit[];
  diff: TaskDiffResult;
};

function BranchFacts({ task, data }: { task: Task; data: ReviewData | null }) {
  const source = data?.diff.sourceBranch || data?.branch || "项目当前分支";
  const target = data?.diff.targetBranch || task.worktreeBase || "项目当前分支";
  return (
    <dl className="single-review-facts">
      <div><dt>源分支</dt><dd><GitBranch size={12} />{source}</dd></div>
      <div><dt>合入目标</dt><dd>{target}</dd></div>
      <div><dt>比较基点</dt><dd>{data?.diff.mergeBase?.slice(0, 12) || "由服务端解析"}</dd></div>
    </dl>
  );
}

function SharedWorkerFacts({ parent, branch }: { parent: Task; branch: string | null }) {
  const params = new URLSearchParams({ project: parent.projectId, task: parent.id });
  return (
    <>
      <dl className="single-review-facts">
        <div><dt>执行归属</dt><dd>{parent.title}</dd></div>
        <div><dt>共享分支</dt><dd><GitBranch size={12} />{branch || "由父团队统一管理"}</dd></div>
        <div><dt>验收方式</dt><dd>随父团队整体验收</dd></div>
      </dl>
      <div className="single-review-shared-note">
        <div><b>该执行者不单独合入</b><p>代码与同组执行者共同位于父团队共享分支，无法可靠按单个执行者切分 diff。请结合下方审查证据，在团队验收台核对共享改动并统一验收。</p></div>
        <a href={`/?${params.toString()}`}>打开父团队</a>
      </div>
    </>
  );
}

function CommitList({ branch, commits }: { branch: string | null; commits: TaskCommit[] }) {
  return (
    <section className="single-review-commits">
      <header><span><GitCommit size={13} />提交</span><b>{commits.length}</b></header>
      {branch && <code className="single-review-branch" title={branch}>{branch}</code>}
      {!commits.length && <p>没有可归属到该任务分支的提交。</p>}
      {commits.map((commit) => (
        <article key={commit.sha}>
          <code>{commit.sha.slice(0, 8)}</code>
          <div><b>{commit.subject}</b><time>{formatInstant(commit.at)}</time></div>
        </article>
      ))}
    </section>
  );
}

export function TaskReviewWorkspace({
  task,
  allTasks,
  onClose,
  onTaskUpdated,
  notify,
}: {
  task: Task;
  allTasks: Task[];
  onClose: () => void;
  onTaskUpdated: (task: Task) => void;
  notify: (message: string) => void;
}) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [sharedBranch, setSharedBranch] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const objective = parseAttachmentText(task.body);
  const display = taskDisplayStatus(task.status, task.stage, !!task.question);
  const sharedParent = sharedTeamParent(task, allTasks);
  const parentTask = task.parentId ? allTasks.find((candidate) => candidate.id === task.parentId) ?? null : null;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setData(null);
    setSharedBranch(null);
    const request = sharedParent
      ? api.taskCommits(sharedParent.id).then((commits) => { if (alive) setSharedBranch(commits.branch); })
      : Promise.all([api.taskCommits(task.id), api.taskDiff(task.id)]).then(
      ([commits, diff]) => {
        if (alive) setData({ branch: commits.branch, commits: commits.commits, diff });
      });
    request.then(
      () => undefined,
      (reason) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); },
    ).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sharedParent?.id, task.id, task.updatedAt]);

  return (
    <section className="single-review-workspace">
      <header className="single-review-subbar">
        <div><b>{sharedParent ? "共享执行者审查" : "改动与提交"}</b><small>{sharedParent ? "该执行者随父团队共享分支统一验收" : "核对真实审查证据与任务分支相对基线的 diff"}</small></div>
        <LegacyLink projectId={task.projectId} taskId={task.id} view="review" />
        <button type="button" onClick={onClose}><X size={13} />返回对话</button>
      </header>
      <div className="single-review-scroll">
        <article className="single-review-card">
          <header className="single-review-card-head">
            <CaretDown size={13} weight="bold" />
            <i className="single-review-stage-dot" />
            <div>
              <span><b>{task.title}</b><em>{sharedParent ? "共享执行者" : "单任务"}</em><small>{display.label}</small></span>
              <p>{objective.body.trim() || "未填写任务目标"}</p>
            </div>
            {sharedParent ? <span className="single-review-shared-badge">随团队验收</span> : <AcceptanceControls task={task} onTaskUpdated={onTaskUpdated} notify={notify} />}
          </header>
          <div className="single-review-card-body">
            <MessageAttachments paths={objective.paths} />
            {sharedParent ? <SharedWorkerFacts parent={sharedParent} branch={sharedBranch} /> : <BranchFacts task={task} data={data} />}
            <ReviewEvidence task={task} parentTask={parentTask} notify={notify} />
            {loading && <p className="single-review-loading"><SpinnerGap size={14} className="is-spinning" />{sharedParent ? "正在读取共享分支归属…" : "正在汇总提交与 diff…"}</p>}
            {!loading && error && <p className="single-review-error">{sharedParent ? "共享分支归属读取失败" : "提交与 diff 加载失败"}：{error}</p>}
            {!sharedParent && !loading && data && (
              <div className="single-review-content">
                <CommitList branch={data.branch} commits={data.commits} />
                <ReviewDiffViewer result={data.diff} />
              </div>
            )}
          </div>
        </article>
      </div>
    </section>
  );
}
