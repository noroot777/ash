import { useCallback, useEffect, useMemo, useState } from "react";
import { TASK_STATUS_LABELS, type TaskReviewInfo, type TaskReviewRound } from "@harness/shared";
import { CaretDown, CaretLeft, CaretRight, CheckCircle, ImageSquare, SpinnerGap, WarningCircle, X } from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";

type EvidenceImage = { round: number; name: string; src: string };

function conclusionLabel(round: TaskReviewRound): string {
  if (round.conclusion === "verified") return "verified";
  if (round.conclusion === "verify_failed") return "verify_failed";
  return "verifying";
}

function EvidenceLightbox({ images, index, onIndex, onClose }: { images: EvidenceImage[]; index: number; onIndex: (index: number) => void; onClose: () => void }) {
  const image = images[index];
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && images.length > 1) onIndex((index - 1 + images.length) % images.length);
      if (event.key === "ArrowRight" && images.length > 1) onIndex((index + 1) % images.length);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [images.length, index, onClose, onIndex]);
  if (!image) return null;
  return (
    <div className="team-evidence-lightbox" role="dialog" aria-modal="true" aria-label={image.name} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <header><span>第 {image.round} 轮 · {image.name}</span><small>{index + 1} / {images.length}</small></header>
      <button type="button" className="team-lightbox-close" aria-label="关闭图片" onClick={onClose}><X size={18} /></button>
      {images.length > 1 && <button type="button" className="team-lightbox-prev" aria-label="上一张" onClick={() => onIndex((index - 1 + images.length) % images.length)}><CaretLeft size={24} /></button>}
      <img src={image.src} alt={image.name} />
      {images.length > 1 && <button type="button" className="team-lightbox-next" aria-label="下一张" onClick={() => onIndex((index + 1) % images.length)}><CaretRight size={24} /></button>}
    </div>
  );
}

function ReviewRound({ taskId, round, images, onPreview }: { taskId: string; round: TaskReviewRound; images: EvidenceImage[]; onPreview: (image: EvidenceImage) => void }) {
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
          {round.reportMarkdown ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{round.reportMarkdown}</ReactMarkdown> : <p>审查报告尚未写入。</p>}
          {round.screenshots.length > 0 && (
            <section className="team-review-shots">
              <h5><ImageSquare size={12} />截图 · {round.screenshots.length}</h5>
              <div>
                {round.screenshots.map((name) => {
                  const image = images.find((candidate) => candidate.round === round.round && candidate.name === name)!;
                  return (
                    <button type="button" key={name} onClick={() => onPreview(image)} title="点击查看大图">
                      <img src={api.taskReviewFileUrl(taskId, round.round, name)} alt={name} loading="lazy" />
                      <span>{name}</span>
                    </button>
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
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
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
  const images = useMemo(() => rounds.flatMap((round) => round.screenshots.map((name) => ({
    round: round.round,
    name,
    src: api.taskReviewFileUrl(taskId, round.round, name),
  }))), [rounds, taskId]);

  return (
    <section className="team-review-evidence">
      <header><div><b>独立审查证据</b><small>{rounds.length ? `已记录 ${rounds.length} 轮真实运行验证` : "验收前请结合结论、报告与截图判断"}</small></div></header>
      {loading && <p><SpinnerGap size={13} className="is-spinning" />正在读取审查记录…</p>}
      {!loading && error && <p className="is-error">审查记录加载失败：{error} <button type="button" onClick={() => void load()}>重试</button></p>}
      {!loading && !error && !rounds.length && <p>尚无独立审查记录。</p>}
      {rounds.map((round) => <ReviewRound key={`${round.round}-${round.reviewTaskId}`} taskId={taskId} round={round} images={images} onPreview={(image) => setPreviewIndex(images.indexOf(image))} />)}
      {previewIndex !== null && <EvidenceLightbox images={images} index={previewIndex} onIndex={setPreviewIndex} onClose={() => setPreviewIndex(null)} />}
    </section>
  );
}
