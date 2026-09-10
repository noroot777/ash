import { useState } from "react";
import type { AnnotationBatch, AnnotationDraft } from "@ash/shared/page-annotation-batch";
import { evidenceLabels } from "@ash/shared/page-annotation-batch";

export function AnnotationRecord({ batch, item }: { batch: AnnotationBatch; item: AnnotationDraft }) {
  const images = batch.evidence.filter((entry) => entry.annotationId === item.id && entry.path);
  return <div className="annotation-record">
    <strong>#{item.number} · {item.comment}</strong>
    <p>{item.element ? `<${item.element.tag}> ${item.element.role} · ${item.element.text || "无可读文字"}` : `圈选区域 · ${item.tool}`}</p>
    <small>{item.context.route} · {new Date(item.context.capturedAt).toLocaleString()} · 原视口 {item.context.viewport.width} × {item.context.viewport.height}</small>
    {images.length ? images.map((entry) => <figure key={entry.id}>
      <img src={`/api/uploads/${encodeURIComponent(entry.path!.split(/[\\/]/).pop()!)}`} alt={`批注 #${item.number} 的原记录图像`} loading="lazy" />
      <figcaption>{evidenceLabels[entry.source]} · {new Date(entry.capturedAt).toLocaleString()}<br />{entry.missing.join("；")}</figcaption>
    </figure>) : <p className="annotation-record-missing">未存图像 · 目标摘要：{item.element?.selectors.join(" / ") || `原文档位置 ${Math.round(item.points[0].x)}, ${Math.round(item.points[0].y)}`}。这是原记录，不是当前页面。</p>}
  </div>;
}

export function AnnotationFollowup({ disabled, onSave }: { disabled: boolean; onSave: (comment: string) => Promise<boolean> }) {
  const [comment, setComment] = useState("");
  return <div className="annotation-followup">
    <label>补充意见（另存为新批次）<textarea value={comment} maxLength={3500} disabled={disabled}
      placeholder="继续说明这条意见，已发送的现场保持原样" onChange={(event) => setComment(event.target.value)} /></label>
    <button type="button" disabled={disabled || !comment.trim()} onClick={() => void onSave(comment).then((saved) => { if (saved) setComment(""); })}>存为新批次，预览后发送</button>
  </div>;
}
