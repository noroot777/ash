import { useCallback, useEffect, useState } from "react";
import { TASK_STATUS_LABELS, type TaskReviewInfo, type TaskReviewRound } from "@harness/shared";
import { CaretDown, CheckCircle, ImageSquare, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { ImagePreviewGroup, PreviewableImage } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";

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

export function ReviewEvidence({ taskId }: { taskId: string }) {
  const [info, setInfo] = useState<TaskReviewInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setInfo(await api.taskReview(taskId));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [taskId]);
  useEffect(() => {
    setInfo(null);
    setLoading(true);
    void load();
  }, [load]);
  useServerEvents(useCallback((event) => {
    if ((event.type === "task.review" || event.type === "task.stage") && event.taskId === taskId) void load();
  }, [load, taskId]));
  const rounds = info?.rounds ?? [];

  return (
    <ImagePreviewGroup isolated>
      <section className="team-review-evidence">
        <header><div><b>独立审查证据</b><small>{rounds.length ? `已记录 ${rounds.length} 轮真实运行验证` : "验收前请结合结论、报告与截图判断"}</small></div></header>
        {loading && <p><SpinnerGap size={13} className="is-spinning" />正在读取审查记录…</p>}
        {!loading && error && <p className="is-error">审查记录加载失败：{error} <button type="button" onClick={() => void load()}>重试</button></p>}
        {!loading && !error && !rounds.length && <p>尚无独立审查记录。</p>}
        {rounds.map((round) => <ReviewRound key={`${round.round}-${round.reviewTaskId}`} taskId={taskId} round={round} />)}
      </section>
    </ImagePreviewGroup>
  );
}
