import { useMemo } from "react";
import type { InspectorDescriptor } from "../inspector/index.ts";
import { InspButton, InspNone } from "../inspector/parts.tsx";
import { PreviewWorkspace } from "./PreviewWorkspace.tsx";

// 右侧面板里「预览指正」那一格。打开之后整份预览指正（页面、标注工具、意见栏）就长在这一格里，
// 而不是替换中间那一栏：边看页面边圈、边跟 agent 说话，会话和回复框得一直留着。打开着时它是宽格
// （跟会话大约五五开、可拖，同「浏览器」那一格）、自带头带（关闭键在工作区自己的头带上）；没打开时
// 是一格普通的空态，一颗键把它打开。「放大预览」才铺满整个窗口。

export const PREVIEW_TAB = "preview";

export interface PreviewTabState {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

export function PreviewPane({ taskId, preview }: { taskId: string; preview: PreviewTabState }) {
  if (preview.open) return <PreviewWorkspace key={taskId} taskId={taskId} onClose={preview.onClose} />;
  return (
    <div className="insp-pane">
      <InspNone action={<InspButton onClick={preview.onOpen}>打开预览指正</InspButton>}>
        在页面上圈出要改的地方，逐条写意见。
      </InspNone>
    </div>
  );
}

/** 打开着时把「预览指正」那一格换成宽格、自带头带；没打开就原样返回。 */
export function usePreviewTab<Context>(
  descriptors: readonly InspectorDescriptor<Context>[],
  open: boolean,
): readonly InspectorDescriptor<Context>[] {
  return useMemo(() => (open
    ? descriptors.map((descriptor) => (descriptor.id === PREVIEW_TAB ? { ...descriptor, wide: true, bare: true } : descriptor))
    : descriptors), [descriptors, open]);
}
