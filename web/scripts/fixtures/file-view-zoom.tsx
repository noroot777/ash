import { StrictMode, useRef } from "react";
import { createRoot } from "react-dom/client";
import { NotePencil, TreeStructure } from "@phosphor-icons/react";
import { TaskFileLinks } from "../../src/components/TaskFileLink.tsx";
import { FileTreeInspector } from "../../src/files/FileTreeInspector.tsx";
import { useFileViewTab } from "../../src/files/fileViewTab.tsx";
import { useFileView, type FileView } from "../../src/files/useFileView.ts";
import { InspectorHost } from "../../src/inspector/InspectorHost.tsx";
import type { InspectorDescriptor } from "../../src/inspector/index.ts";
import "../../src/styles/global.css";

const TASK_ID = "task-1";
const FILE_TABS = ["files"] as const;

type Context = { task: { id: string }; fileView: FileView; notify: (message: string) => void };

const DESCRIPTORS: readonly InspectorDescriptor<Context>[] = [
  {
    id: "files",
    title: "文件",
    icon: <TreeStructure size={15} aria-hidden="true" />,
    defaultOpen: true,
    render: (context) => (
      <FileTreeInspector
        notify={context.notify}
        taskId={context.task.id}
        activePath={context.fileView.activePath}
        onOpenFile={context.fileView.openFile}
        onOpenDiff={context.fileView.openDiff}
        onOpenFolder={context.fileView.openFolder}
      />
    ),
  },
  {
    id: "notes",
    title: "备忘",
    icon: <NotePencil size={15} aria-hidden="true" />,
    defaultOpen: true,
    render: () => <p style={{ padding: 10 }}>这一轮没有备忘。</p>,
  },
];

// 复刻真实页面的整套外壳（同 `review-diff-zoom.tsx`）：`.workspace-system-layout` 的网格里有
// 工作区那一行和底下横贯窗口的坞，工作区那一行里是左边任务栏、中间的会话、右边 inspector。
//
// 「查看」那一格走真的接线：`useFileViewTab` 往真的 `InspectorHost` 里插格、用 `reveal` 亮出来，
// 跟 TaskDetail / TeamView 同一条路——格子跟着内容出现、消失，放大层从面板里铺开。外面那层
// `TaskFileLinks` 也照真实页面包住整个 InspectorHost：那一格里的 Markdown 再点别的文件走的是它。
function Fixture() {
  const view = useFileView(TASK_ID);
  const { inspectors, reveal } = useFileViewTab(DESCRIPTORS, view, FILE_TABS);
  const toggle = useRef<(() => void) | null>(null);
  const context = { task: { id: TASK_ID }, fileView: view, notify: () => undefined };

  return (
    <TaskFileLinks taskId={TASK_ID} onOpenFile={view.openFile} onOpenFolder={view.openFolder} onOpenError={() => undefined}>
    <div className="workspace-system-layout" style={{ height: "100vh" }}>
      <div />
      <div className="workspace-shell">
        <aside id="fixture-rail" style={{ width: 220, minWidth: 220, background: "var(--chrome)", padding: 12 }}>
          任务栏
        </aside>
        <div style={{ display: "flex", minWidth: 0, flex: 1, isolation: "isolate", position: "relative" }}>
          <InspectorHost contextKey="file-view-zoom-fixture" context={context} descriptors={inspectors} reveal={reveal}>
            {(controls) => {
              toggle.current = controls.toggle;
              return (
                <section id="fixture-main" style={{ display: "flex", flex: 1, flexDirection: "column", gap: 8, padding: 16 }}>
                  <p data-testid="conversation" style={{ color: "var(--faint)" }}>会话</p>
                  {/* 正文里提到的路径：不经过文件树，直接 openFile。 */}
                  <button type="button" onClick={() => view.openFile("clean.ts")}>正文里的 clean.ts</button>
                  <button type="button" onClick={() => view.openFile("guide.md")}>正文里的 guide.md</button>
                  <textarea aria-label="回复框" />
                </section>
              );
            }}
          </InspectorHost>
        </div>
      </div>
      {/* 底部坞：终端（收起时不占行）压在全局状态栏上。 */}
      <div
        id="fixture-dock"
        style={{ display: "flex", height: 36, alignItems: "center", gap: 8, background: "var(--chrome)", borderTop: ".5px solid var(--line)", padding: "0 8px" }}
      >
        状态栏
        <button type="button" onClick={() => toggle.current?.()}>开合右侧面板</button>
      </div>
    </div>
    </TaskFileLinks>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
