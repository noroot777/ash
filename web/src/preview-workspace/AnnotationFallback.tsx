import type { AnnotationBatchRecord } from "@ash/shared/page-annotation-batch";
import { ScreenshotAnnotation } from "../page-annotation/ScreenshotAnnotation.tsx";
import { api } from "../lib/api.ts";

export function AnnotationFallback({ taskId, records, queueing, unavailable = false }: { taskId: string; records: AnnotationBatchRecord[]; queueing: boolean; unavailable?: boolean }) {
  const paths = [...new Set(records.flatMap((record) => record.batch.evidence.flatMap((entry) => entry.path ? [entry.path] : [])))];
  return <div className="annotation-fallback">
    <ScreenshotAnnotation taskId={taskId} disabled={false} queueing={queueing} executorLabel="此任务的智能体"
      triggerLabel={unavailable ? "改用截图批注" : "此页面在内嵌预览中表现异常？改用截图批注"}
      candidates={paths.map((path) => ({ path, name: path.split(/[\\/]/).pop()!, url: `/api/uploads/${encodeURIComponent(path.split(/[\\/]/).pop()!)}` }))}
      onSend={async (reply) => { await api.replyTask(taskId, reply.text, { attachments: reply.attachments }); return true; }} />
  </div>;
}
