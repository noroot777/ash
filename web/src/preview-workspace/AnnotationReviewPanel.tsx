import type { AnnotationBatchRecord, AnnotationDraft } from "@ash/shared/page-annotation-batch";
import type { AnnotationMatch } from "@ash/shared/page-annotation-review";
import { AnnotationFollowup, AnnotationRecord } from "./AnnotationRecord.tsx";
import type { useAnnotationBatch } from "./useAnnotationBatch.ts";
import type { useAnnotationReview } from "./useAnnotationReview.ts";

export function AnnotationReviewPanel({ record, item, match, ready, gen, controller, review, onLocate, onContinue }: {
  record: AnnotationBatchRecord; item: AnnotationDraft; match: AnnotationMatch | null; ready: boolean; gen: string;
  controller: ReturnType<typeof useAnnotationBatch>; review: ReturnType<typeof useAnnotationReview>;
  onLocate: () => void; onContinue: () => Promise<void>;
}) {
  const decision = record.review?.decisions.find((entry) => entry.itemId === item.id);
  const disabled = !ready || !review.status?.canReopen || review.busy || controller.busy || controller.review;
  return <section className="annotation-review-panel" aria-label={`复看批注 ${item.number}`}>
    <h4>逐条复看 · #{item.number}</h4>
    <p>智能体回合：{record.review?.releasedAt ? `已释放（${record.review.roundStatus}）` : "等待释放"}<br />
      用户确认：{decision ? decision.verdict === "satisfied" ? "满意" : "继续圈" : "尚未确认"}</p>
    <button type="button" disabled={disabled} onClick={onLocate}>在新页面重找此元素</button>
    <p role="status">{match ? match.reason : "选择此条后重找元素；旧坐标不会贴到新页面。"}</p>
    {match?.reliable && <p>当前候选：&lt;{match.element?.tag}&gt; {match.element?.text} · 匹配得分 {Math.round(match.score * 100)}%</p>}
    <details open={!match?.reliable}><summary>回看原记录与图像</summary><AnnotationRecord batch={record.batch} item={item} /></details>
    {review.error && <p role="alert" className="preview-workspace-error">{review.error}</p>}
    <div className="annotation-review-actions">
      <button type="button" disabled={disabled} onClick={() => void review.decide(record, item.id, "satisfied", gen).then((next) => { if (next) controller.remember(next); })}>满意</button>
      <button type="button" disabled={disabled} onClick={() => void onContinue()}>继续圈</button>
    </div>
    <AnnotationFollowup disabled={controller.busy || controller.review} onSave={(comment) => controller.followup(record.batch, item, comment)} />
  </section>;
}
