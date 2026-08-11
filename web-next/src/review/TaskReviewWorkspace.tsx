import { useEffect, useState } from "react";
import type { Task } from "@harness/shared";
import {
  GitBranch,
  SpinnerGap,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { api, type TaskCommit, type TaskDiffResult } from "../lib/api.ts";
import { freeReviewBlockingLabel, freeReviewView } from "../free-workflow/freeReviewCopy.ts";
import { useFreeWorkflowState } from "../free-workflow/useFreeWorkflowState.ts";
import { AcceptanceControls } from "../team/TeamReviewWorkspace.tsx";
import { ChangeMetaBar } from "./ChangeMetaBar.tsx";
import { ReviewDiffViewer } from "./ReviewDiffViewer.tsx";
import { sharedTeamParent } from "./reviewModel.ts";

type ReviewData = {
  branch: string | null;
  commits: TaskCommit[];
  diff: TaskDiffResult;
};

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
  const sharedParent = sharedTeamParent(task, allTasks);
  const free = useFreeWorkflowState(task.id, task.workflowMode === "free");
  const activeFreeReview = free.state?.reviews.find((run) => freeReviewBlockingLabel(run) !== null);
  const acceptanceBlock = task.workflowMode !== "free"
    ? null
    : activeFreeReview
      ? freeReviewBlockingLabel(activeFreeReview)
      : !free.state && free.loading
          ? "读取审查状态"
          : !free.state && free.error
            ? "审查状态未知"
            : null;
  // 非阻塞警示：验收是用户主权，但「最后一轮没过 / 链异常断了 / 通过后代码又变了 /
  // 新鲜度无从判断」必须摆在明面上。失败向着「不确定」开，不向「没问题」开。
  const freeView = task.workflowMode === "free" ? freeReviewView(free.state, task) : null;
  const acceptanceWarning = !freeView || task.stage === "accepted"
    ? null
    : freeView.stoppedRun
      ? `最后一轮审查未通过（第 ${freeView.stoppedRun.currentRound} 轮）——验收合并即表示你接受该风险`
      : freeView.failedRun
        ? "最近一条审查链异常停止，没有产出有效结论——建议再派一轮审查后验收"
        : freeView.stale
          ? "审查通过后代码又有变化（新提交或未提交改动），结论可能已过期——可先「审查新改动」再验收"
          : freeView.freshness === "unknown"
            ? "无法确认审查结论对应当前代码（缺少审查基准或工作区不可读）——请自行核对 diff 后再验收"
            : null;

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
      {/* 和团队验收台同一副形状：顶栏一行放标题、验收动作和返回，主体只铺这一屏独有的东西
          ——分支信息与 diff。任务标题、状态、目标正文在对话区和右侧 inspector 里各有一份，
          验证证据也在 inspector 里点得开，再套一张卡片铺一遍只会把真正要看的 diff 往下推。 */}
      <header className="single-review-subbar">
        <div><b>{sharedParent ? "共享执行者审查" : "改动与提交"}</b><small>{sharedParent ? "该执行者随父团队共享分支统一验收" : "验证证据见右侧审查记录；这里核对任务分支相对基线的提交与 diff"}</small></div>
        {sharedParent
          ? <span className="single-review-shared-badge">随团队验收</span>
          : <AcceptanceControls task={task} onTaskUpdated={onTaskUpdated} notify={notify} acceptanceBlock={acceptanceBlock} />}
        <button type="button" onClick={onClose}><X size={13} />返回对话</button>
      </header>
      <div className="single-review-scroll">
        <div className="single-review-stack">
          {acceptanceWarning && (
            <p className="single-review-warning" role="alert">
              <WarningCircle size={14} weight="fill" />{acceptanceWarning}
            </p>
          )}
          {sharedParent && <SharedWorkerFacts parent={sharedParent} branch={sharedBranch} />}
          {loading && <p className="single-review-loading"><SpinnerGap size={14} className="is-spinning" />{sharedParent ? "正在读取共享分支归属…" : "正在汇总提交与 diff…"}</p>}
          {!loading && error && <p className="single-review-error">{sharedParent ? "共享分支归属读取失败" : "提交与 diff 加载失败"}：{error}</p>}
          {!sharedParent && !loading && data && (
            <div className="single-review-content">
              <ChangeMetaBar
                source={data.diff.sourceBranch || data.branch || "项目当前分支"}
                target={data.diff.targetBranch || task.worktreeBase || "项目当前分支"}
                where={data.diff.mergeBase ? `基点 ${data.diff.mergeBase.slice(0, 8)}` : null}
                commits={data.commits}
              />
              <ReviewDiffViewer result={data.diff} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
