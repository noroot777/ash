import type { ReactNode } from "react";
import type { FreeWorkflowPreviewState } from "@ash/shared/free-workflow";
import type { PreviewServiceState } from "@ash/shared/preview";
import { PreviewLauncher } from "./PreviewLauncher.tsx";
import { AnnotationWaiting } from "./AnnotationWaiting.tsx";
import type { useAnnotationBatch } from "./useAnnotationBatch.ts";
import type { useAnnotationReview } from "./useAnnotationReview.ts";

export function previewWorkspaceLaunchHint(preview: FreeWorkflowPreviewState | null, service: PreviewServiceState | undefined,
  sentWaiting: boolean, oldGeneration: boolean): string {
  if (preview?.starting) return "预览正在启动，就绪后会自动接入页面；可在下方查看日志或取消启动。";
  if (sentWaiting) return "批注已投递，当前页面暂不开放；下方可查看启动条件和已存批注，也可使用右侧截图批注。";
  if (service && !preview?.proxied) return "当前预览以直连方式运行，内嵌标注需以代理方式重启。请在下方选择预览命令，也可使用右侧截图批注。";
  if (oldGeneration) return "当前预览仍是投递批注前的版本，请在下方重新启动预览后复看；已存批注与图像保留在下方。";
  return "在下方选择并启动预览，就绪后即可浏览和标注；也可以使用右侧截图批注。";
}

export function PreviewWorkspaceStage({ source, taskId, preview, refresh, controller, review, hint, children }: {
  source: string | null; taskId: string; preview: FreeWorkflowPreviewState | null; refresh: () => Promise<void>;
  controller: ReturnType<typeof useAnnotationBatch>; review: ReturnType<typeof useAnnotationReview>; hint: string; children: ReactNode;
}) {
  return <div className="preview-workspace-stage">
    {source ? children : <div className="preview-workspace-launch-area">
      <PreviewLauncher taskId={taskId} preview={preview} refresh={refresh} hint={hint} />
      {controller.records.some((record) => record.messageId) && <AnnotationWaiting controller={controller} review={review}
        starting={!!preview?.starting} launchAvailable />}
    </div>}
  </div>;
}
