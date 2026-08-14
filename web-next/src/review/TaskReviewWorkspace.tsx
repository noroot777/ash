import { useEffect, useState } from "react";
import type { Task } from "@harness/shared";
import {
  GitBranch,
  GitCommit,
  SpinnerGap,
  WarningCircle,
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
  onTaskUpdated,
  notify,
  onPostMergeReview,
}: {
  task: Task;
  allTasks: Task[];
  onTaskUpdated: (task: Task) => void;
  notify: (message: string) => void;
  onPostMergeReview?: () => void;
}) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [sharedBranch, setSharedBranch] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sharedParent = sharedTeamParent(task, allTasks);
  const free = useFreeWorkflowState(task.id, task.workflowMode === "free");
  const latestPostMerge = free.state?.reviews.find((run) => run.target?.kind === "accepted_merge");
  const acceptedSnapshot = task.stage === "accepted" && task.acceptedTargetBranch && task.acceptedBaseCommit && task.acceptedMergeCommit
    ? { branch: task.acceptedTargetBranch, baseCommit: task.acceptedBaseCommit, mergeCommit: task.acceptedMergeCommit }
    : null;
  const activeFreeReview = free.state?.reviews.find((run) => freeReviewBlockingLabel(run) !== null);
  // 失败关闭：拿不到自由工作流状态（加载中、出错、或任何原因的 state 为空）就不开放
  // 不可逆的验收按钮——「state 空 + loading 已结束」的缝隙也一样（StrictMode 重挂载
  // 曾在这个缝隙里放出过约 2.5 秒的假「验收通过」）。
  // 后端只在终态（done/failed/canceled）放行自由任务验收：paused/backlog 时按钮必须
  // 同步禁用并说明原因，不给「可点却必 409」的假按钮。
  const freeTerminal = ["done", "failed", "canceled"].includes(task.status);
  // 跟工作流无关的两道硬门禁（后端 acceptanceGuard 同款判据）：未收尾的就地验证轮、
  // 待答复的提问。两者都不体现在 status 上——任务确实没有进程在跑，但这一版的生命
  // 周期没结束：验证轮回来会拿结论盖掉 accepted，答复会 resume 会话继续往 worktree
  // 里写，而那时分支已经合并、目录已经删了。
  // 已验收/已合并的不再算：那一版早已定稿，此时挂着的验证轮或提问属于「被唤醒之后的
  // 新一版」，拿它去禁上一版的验收视图只会让人以为验收没生效。
  const settledStage = task.stage === "accepted" || task.stage === "merged";
  const pendingTurnBlock = settledStage
    ? null
    : task.verifyRound != null
      ? `第 ${task.verifyRound} 轮验证还没出结论`
      : task.question
        ? "有待答复的提问"
        : null;
  const acceptanceBlock = pendingTurnBlock ?? (task.workflowMode !== "free"
    ? null
    : activeFreeReview
      ? freeReviewBlockingLabel(activeFreeReview)
      : task.stage !== "accepted" && task.stage !== "merged" && !freeTerminal
        ? "任务尚未结束"
        : free.error
          ? "审查状态未知"
          : !free.state
            ? "读取审查状态"
            : null);
  // 非阻塞警示：验收是用户主权，但「最后一轮没过 / 链异常断了 / 通过后代码又变了 /
  // 新鲜度无从判断」必须摆在明面上。失败向着「不确定」开，不向「没问题」开。
  const freeView = task.workflowMode === "free" ? freeReviewView(free.state, task) : null;
  const acceptanceWarning = !freeView || task.stage === "accepted"
    ? null
    : freeView.stoppedRun && (freeView.stale || freeView.freshness === "unknown")
      ? "上一份未通过报告针对的是旧版代码，已过期；当前版本没有有效审查结论——建议再派一轮审查后验收"
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
      {/* 和团队验收台同一副形状：顶栏一行放标题和验收动作，主体只铺这一屏独有的东西
          ——分支信息与 diff。任务标题、状态、目标正文在对话区和右侧 inspector 里各有一份，
          验证证据也在 inspector 里点得开，再套一张卡片铺一遍只会把真正要看的 diff 往下推。
          返回口只留任务顶栏那一个（验收台开着时「验收」主按钮就变成「返回对话」），这里
          不再重复第二个。 */}
      <header className="single-review-subbar">
        <div><b>{sharedParent ? "共享执行者审查" : "改动与提交"}</b><small>{sharedParent ? "该执行者随父团队共享分支统一验收" : "验证证据见右侧审查记录；这里核对任务分支相对基线的提交与 diff"}</small></div>
        {sharedParent
          ? <span className="single-review-shared-badge">随团队验收</span>
          : <AcceptanceControls task={task} onTaskUpdated={onTaskUpdated} notify={notify} acceptanceBlock={acceptanceBlock} />}
      </header>
      <div className="single-review-scroll">
        <div className="single-review-stack">
          {acceptanceWarning && (
            <p className="single-review-warning" role="alert">
              <WarningCircle size={14} weight="fill" />{acceptanceWarning}
            </p>
          )}
          {acceptedSnapshot && (
            <section className="accepted-snapshot-card" aria-label="验收合并快照">
              <header><span><GitCommit size={13} /></span><div><b>验收快照</b><small>合并完成时冻结，后续分支移动不会改变本次审查范围</small></div><em>已验收</em></header>
              <dl>
                <div><dt>目标分支</dt><dd>{acceptedSnapshot.branch}</dd></div>
                <div><dt>合并区间</dt><dd>{acceptedSnapshot.baseCommit.slice(0, 8)} → {acceptedSnapshot.mergeCommit.slice(0, 8)}</dd></div>
              </dl>
              {onPostMergeReview && (
                <button type="button" onClick={onPostMergeReview}>
                  {latestPostMerge?.status === "reviewing"
                    ? "合并结果正在审查，查看进度"
                    : latestPostMerge ? "需要额外确认最终集成状态？再次审查本次合并" : "需要额外确认最终集成状态？审查本次合并"}
                </button>
              )}
            </section>
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
