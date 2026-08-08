import type { FreeReviewRun, Task } from "@harness/shared";
import { CheckCircle, GitMerge, MagnifyingGlass, MonitorPlay, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { useFreeWorkflowState } from "./useFreeWorkflowState.ts";

const RUN_LABELS: Record<FreeReviewRun["status"], string> = {
  reviewing: "审查中",
  repairing: "修改中，完成后自动复审",
  passed: "已通过",
  exhausted: "轮数用尽，等待人工决定",
  failed: "审查链异常停止",
};

export function FreeWorkflowInspector({ task, reviewOnly = false }: { task: Task; reviewOnly?: boolean }) {
  const free = useFreeWorkflowState(task.id);
  if (free.loading && !free.state) return <div className="free-workflow-inspector is-loading"><SpinnerGap size={14} className="is-spinning" />正在生成实际工作流…</div>;
  if (free.error && !free.state) return <div className="free-workflow-inspector is-loading is-error"><WarningCircle size={14} />{free.error}</div>;
  const state = free.state;
  const reviews = state?.reviews ?? [];

  return (
    <div className="free-workflow-inspector">
      {!reviewOnly && (
        <section className="free-workflow-generated">
          <header><span>根据实际情况生成</span><small>这里不预判下一步，只记录真正发生过的操作。</small></header>
          <ol>
            <li className="is-done"><span><CheckCircle size={14} weight="fill" /></span><div><b>任务执行</b><small>{task.status === "running" ? "正在进行" : `当前状态：${task.status}`}</small></div></li>
            {reviews.map((run) => (
              <li key={run.id} className={run.status === "passed" ? "is-done" : run.status === "failed" || run.status === "exhausted" ? "is-warning" : "is-active"}>
                <span>{run.status === "reviewing" || run.status === "repairing" ? <SpinnerGap size={14} className="is-spinning" /> : run.status === "passed" ? <CheckCircle size={14} weight="fill" /> : <MagnifyingGlass size={14} />}</span>
                <div><b>{run.reviewerName} · {run.checkMode === "logic" ? "逻辑检查" : "语法检查"}</b><small>{RUN_LABELS[run.status]} · 已到第 {run.currentRound} 轮 / 最多 {run.retryLimit + 1} 轮</small></div>
              </li>
            ))}
            {state?.preview.running && <li className="is-active"><span><MonitorPlay size={14} /></span><div><b>预览已打开</b><small>{state.preview.url ?? state.preview.command}</small></div></li>}
            {state?.merge.status !== "idle" && <li className={state?.merge.status === "merged" ? "is-done" : state?.merge.status === "failed" ? "is-warning" : "is-active"}><span><GitMerge size={14} /></span><div><b>合并&清理</b><small>{state?.merge.message ?? "处理中"}</small></div></li>}
          </ol>
          {!reviews.length && !state?.preview.running && state?.merge.status === "idle" && <p>目前只有任务执行本身；派审、预览或合并后，这里会按发生顺序补出记录。</p>}
        </section>
      )}

      <section className="free-review-history">
        <header><b>审查记录</b><small>{reviews.length ? `${reviews.length} 轮审查链` : "尚未派审"}</small></header>
        {!reviews.length && <p>点击会话上方的“派审查”，选择审查者、检查类型和自动复审次数。</p>}
        {reviews.map((run) => (
          <details key={run.id}>
            <summary><span><b>{run.reviewerName}</b><small>{run.checkMode === "logic" ? "逻辑检查" : "语法检查"} · {RUN_LABELS[run.status]}</small></span><em>{run.rounds.length} 轮</em></summary>
            <div>
              {run.rounds.map((round) => (
                <article key={round.round}>
                  <header><b>第 {round.round} 轮</b><span>{round.status === "reviewing" ? "进行中" : round.conclusion === "verified" ? "通过" : round.conclusion === "verify_failed" ? "未通过" : "异常"}</span></header>
                  {round.reportMarkdown ? <pre>{round.reportMarkdown}</pre> : <p>报告尚未生成。</p>}
                  {!!round.screenshots.length && <div className="free-review-screenshots">{round.screenshots.map((name) => <a key={name} href={api.freeReviewFileUrl(task.id, run.id, round.round, name)} target="_blank" rel="noreferrer"><img src={api.freeReviewFileUrl(task.id, run.id, round.round, name)} alt={name} /><span>{name}</span></a>)}</div>}
                </article>
              ))}
            </div>
          </details>
        ))}
      </section>
    </div>
  );
}
