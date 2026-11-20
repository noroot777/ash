import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Browser, Info } from "@phosphor-icons/react";
import { LeftDrawerProvider, useLeftDrawerHost } from "../../src/components/LeftDrawer.tsx";
import { MarkdownBody } from "../../src/components/MarkdownBody.tsx";
import { InspectorHost } from "../../src/inspector/InspectorHost.tsx";
import type { InspectorDescriptor } from "../../src/inspector/index.ts";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import { PREVIEW_TAB, PreviewPane, usePreviewTab, type PreviewTabState } from "../../src/preview-workspace/previewTab.tsx";
import "../../src/styles/global.css";

const TASK_ID = "task-1";

type Context = { task: { id: string }; preview: PreviewTabState };

const DESCRIPTORS: readonly InspectorDescriptor<Context>[] = [
  {
    id: "info",
    title: "信息",
    icon: <Info size={15} aria-hidden="true" />,
    defaultOpen: true,
    render: () => <p style={{ padding: 10 }}>任务信息</p>,
  },
  {
    id: PREVIEW_TAB,
    title: "预览指正",
    icon: <Browser size={15} aria-hidden="true" />,
    defaultOpen: true,
    render: (context) => <PreviewPane taskId={context.task.id} preview={context.preview} />,
  },
];

const REPORT = "证据：[第 1 轮报告](/Users/example/code/navi/data/runs/task-1/review/round-1/report.md)";

// 复刻真实页面的外壳（同 file-view-zoom.tsx）：左边任务栏、中间会话 + 回复框、右边 inspector。
// 「预览指正」那一格走真的接线：TaskDetail 用的就是这一份 PreviewPane + usePreviewTab。中间那一栏
// 照 TaskDetail 是 `.task-detail` + 左侧读全文抽屉的宿主，会话里那条报告链接从左边推出报告。
function Fixture() {
  const [open, setOpen] = useState(false);
  const drawer = useLeftDrawerHost({ resetKey: TASK_ID });
  const inspectors = usePreviewTab(DESCRIPTORS, open);
  const context = { task: { id: TASK_ID }, preview: { open, onOpen: () => setOpen(true), onClose: () => setOpen(false) } };
  return (
    <div className="workspace-system-layout" style={{ height: "100vh" }}>
      <div />
      <div className="workspace-shell">
        <aside id="fixture-rail" style={{ width: 220, minWidth: 220, background: "var(--chrome)", padding: 12 }}>任务栏</aside>
        <div className="workspace-main" style={{ display: "flex", minWidth: 0, flex: 1, isolation: "isolate", position: "relative" }}>
          <LeftDrawerProvider value={drawer.api}>
            <InspectorHost contextKey="preview-tab-fixture" context={context} descriptors={inspectors}>
              {({ toggle }) => (
                <div className="task-detail">
                  <header className="task-detail-header">任务头</header>
                  <section id="fixture-main" style={{ display: "flex", minHeight: 0, flex: 1, flexDirection: "column", gap: 8, padding: 16 }}>
                    <p data-testid="conversation" style={{ color: "var(--faint)" }}>会话</p>
                    <MarkdownBody text={REPORT} />
                    <div style={{ flex: 1 }} />
                    <button type="button" onClick={toggle}>开合右侧面板</button>
                    <textarea aria-label="回复框" />
                  </section>
                  {drawer.drawer}
                </div>
              )}
            </InspectorHost>
          </LeftDrawerProvider>
        </div>
      </div>
      <div id="fixture-dock" style={{ height: 36, background: "var(--chrome)", borderTop: ".5px solid var(--line)" }}>状态栏</div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* 真实页面的草稿仓在 App 层；截图批注（意见栏里那颗）要它。 */}
    <DraftProvider>
      <Fixture />
    </DraftProvider>
  </StrictMode>,
);
