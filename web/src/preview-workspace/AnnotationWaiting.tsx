import { batchStateLabels } from "@ash/shared/page-annotation-batch";
import type { useAnnotationBatch } from "./useAnnotationBatch.ts";
import type { useAnnotationReview } from "./useAnnotationReview.ts";
import { AnnotationFollowup, AnnotationRecord } from "./AnnotationRecord.tsx";

export function AnnotationWaiting({ controller: c, review, starting, launchAvailable = false }: {
  controller: ReturnType<typeof useAnnotationBatch>; review: ReturnType<typeof useAnnotationReview>; starting: boolean; launchAvailable?: boolean;
}) {
  const sent = c.records.filter((record) => record.messageId);
  return <section className="annotation-waiting" aria-label="修改期等待区">
    <h3>{starting || review.busy ? "预览正在准备…" : "修改与复看等待区"}</h3>
    <p className="annotation-waiting-notice">以下是已保存的批注与图像，<strong>这不是可操作页面</strong>。可继续补评论，新意见将作为新批次发送。</p>
    <p role="status">{!review.status ? "正在核对回合与后续消息状态…" : review.status.reason || "智能体回合已释放；请逐条复看，用户满意需单独确认。"}</p>
    {!launchAvailable && sent.some((record) => record.state === "reviewable") && review.canPrompt && !c.busy && !c.review && <div className="annotation-reopen" role="status">
      <strong>回合已释放，且没有待投递的后续消息，可以重新打开预览。</strong>
      <button type="button" disabled={review.busy || starting} onClick={() => void review.reopen()}>重新打开预览</button>
      <button type="button" onClick={() => review.dismiss()}>不再自动提示</button>
    </div>}
    {review.dismissed && <p>已停止自动重开提示。<button type="button" onClick={() => review.dismiss(false)}>恢复提示</button></p>}
    {review.error && <p role="alert" className="preview-workspace-error">{review.error}</p>}
    {!sent.length && <p>尚无已发送批次，可使用右侧截图批注。</p>}
    {sent.map((record) => <section key={record.batch.id} className="annotation-waiting-batch">
      <h4>{batchStateLabels[record.state]} · {new Date(record.batch.createdAt).toLocaleString()}</h4>
      <small>批次 {record.batch.id}</small>
      {record.review?.releasedAt && <p>智能体回合已释放：{new Date(record.review.releasedAt).toLocaleString()}（{record.review.roundStatus}）；用户已确认满意 {record.review.decisions.filter((d) => d.verdict === "satisfied").length} / {record.batch.items.length} 条</p>}
      {record.batch.items.map((item) => <article key={item.id}>
        <AnnotationRecord batch={record.batch} item={item} />
        <AnnotationFollowup disabled={c.busy || c.review} onSave={(comment) => c.followup(record.batch, item, comment)} />
      </article>)}
    </section>)}
  </section>;
}
