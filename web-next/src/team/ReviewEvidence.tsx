import { useState } from "react";
import { TASK_STATUS_LABELS, type Task, type TaskReviewRound } from "@harness/shared";
import { CaretDown, CheckCircle, ImageSquare, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { ImagePreviewGroup, PreviewableImage } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { api } from "../lib/api.ts";
import { ReviewDispatchControl } from "../review/ReviewDispatchControl.tsx";
import { useTaskReviewInfo } from "../review/useTaskReviewInfo.ts";

function conclusionLabel(round: TaskReviewRound): string {
  if (round.conclusion === "verified") return "verified";
  if (round.conclusion === "verify_failed") return "verify_failed";
  return "verifying";
}

function ReviewRound({ taskId, round }: { taskId: string; round: TaskReviewRound }) {
  const [open, setOpen] = useState(true);
  const label = conclusionLabel(round);
  return (
    <article className={`team-review-round is-${label}`}>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span>{round.round}</span>
        <b>第 {round.round} 轮</b>
        <em>{label === "verified" ? <CheckCircle size={11} weight="fill" /> : label === "verify_failed" ? <WarningCircle size={11} weight="fill" /> : <SpinnerGap size={11} className="is-spinning" />}{label}</em>
        <small>审查任务：{TASK_STATUS_LABELS[round.reviewTaskStatus]}</small>
        <CaretDown size={12} weight="bold" />
      </button>
      {open && (
        <div>
          {round.reportMarkdown ? <MarkdownBody text={round.reportMarkdown} /> : <p>审查报告尚未写入。</p>}
          {round.screenshots.length > 0 && (
            <section className="team-review-shots">
              <h5><ImageSquare size={12} />截图 · {round.screenshots.length}</h5>
              <div>
                {round.screenshots.map((name) => {
                  return (
                    <div className="team-review-shot" key={name} title="点击查看大图">
                      <PreviewableImage src={api.taskReviewFileUrl(taskId, round.round, name)} alt={name} label={`第 ${round.round} 轮 · ${name}`} loading="lazy" />
                      <span>{name}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </article>
  );
}

export function ReviewEvidence({
  task,
  parentTask = null,
  notify,
}: {
  task: Task;
  parentTask?: Task | null;
  notify: (message: string) => void;
}) {
  const { info, loading, error, load } = useTaskReviewInfo(task.id);
  const rounds = info?.rounds ?? [];
  const latestRound = rounds.at(-1);
  const dispatchProminent = !!error || rounds.length === 0 || latestRound?.conclusion === "verify_failed";
  const dispatchSupported = task.mode === "single" && !task.reviewOf && !task.archived;
  const emptyMessage = dispatchSupported
    ? task.status === "running" || task.status === "queued"
      ? "尚无独立审查记录；目标结束后可派出真实运行验证。"
      : "尚无独立审查记录，可立即派出一轮真实运行验证。"
    : "尚无独立审查记录。";

  return (
    <ImagePreviewGroup isolated>
      <section className="team-review-evidence">
        <header><div><b>独立审查证据</b><small>{rounds.length ? `已记录 ${rounds.length} 轮真实运行验证` : "验收前请结合结论、报告与截图判断"}</small></div></header>
        {loading && <p><SpinnerGap size={13} className="is-spinning" />正在读取审查记录…</p>}
        {!loading && error && <p className="is-error">审查记录加载失败：{error} <button type="button" onClick={() => void load()}>重试</button></p>}
        {!loading && !error && !rounds.length && <p>{emptyMessage}</p>}
        {!loading && (
          <ReviewDispatchControl
            task={task}
            parentTask={parentTask}
            rounds={rounds}
            prominent={dispatchProminent}
            notify={notify}
            onRefresh={() => load(true)}
          />
        )}
        {rounds.map((round) => <ReviewRound key={`${round.round}-${round.reviewTaskId}`} taskId={task.id} round={round} />)}
      </section>
    </ImagePreviewGroup>
  );
}
