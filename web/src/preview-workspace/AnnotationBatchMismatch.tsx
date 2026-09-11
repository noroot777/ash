import type { useAnnotationBatch } from "./useAnnotationBatch.ts";

export function AnnotationBatchMismatch({ reason, controller, id }: {
  reason: string | null; controller: ReturnType<typeof useAnnotationBatch>; id?: string;
}) {
  if (!reason) return null;
  return <div className="annotation-batch-mismatch">
    <div>
      <p id={id} role="status">{reason}</p>
      <small>{controller.review ? "发送预览已打开，继续编辑后可新建批次。"
        : "旧批次保留在「已保存批次」，可复看或发送已有意见。"}</small>
      {controller.error && <p role="alert" className="preview-workspace-error">{controller.error}</p>}
    </div>
    <button type="button" disabled={controller.busy || controller.review} onClick={() => void controller.fresh()}>
      {controller.busy ? "正在保存批次…" : "新建批次继续标注"}
    </button>
  </div>;
}
