import type { AnnotationBatch, AnnotationDraft } from "@ash/shared/page-annotation-batch";

export function annotationFollowup(batch: AnnotationBatch, item: AnnotationDraft, comment: string, id: string): AnnotationBatch {
  return { ...batch, id, createdAt: Date.now(), items: [{ ...item,
    comment: `继续批次 ${batch.id} 的 #${item.number}（原记录，非新现场）：\n${comment}` }],
    evidence: batch.evidence.filter((entry) => entry.annotationId === item.id) };
}

export function mergeAnnotationRecord<T extends { revision: number; messageId: string | null }>(known: T | undefined, incoming: T): T {
  return known && (known.revision > incoming.revision || (known.messageId && !incoming.messageId)) ? known : incoming;
}
