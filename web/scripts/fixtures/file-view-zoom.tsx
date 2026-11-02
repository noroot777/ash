import { StrictMode, useRef } from "react";
import { createRoot } from "react-dom/client";
import { FolderOpen, TreeStructure } from "@phosphor-icons/react";
import { FileTreeInspector } from "../../src/files/FileTreeInspector.tsx";
import { FileViewer } from "../../src/files/FileViewer.tsx";
import { FolderViewer } from "../../src/files/FolderViewer.tsx";
import { useFileView } from "../../src/files/useFileView.ts";
import { InspectorHost } from "../../src/inspector/InspectorHost.tsx";
import { ScmDiffViewer } from "../../src/scm/ScmDiffViewer.tsx";
import "../../src/styles/global.css";

const TASK_ID = "task-1";

// 复刻真实页面的整套外壳（同 `review-diff-zoom.tsx`，那边的头注写了每一层为什么必须在）：
// `.workspace-system-layout` 的网格里有工作区那一行和底下横贯窗口的坞，工作区那一行里是
// 左边任务栏、中间摊开的文件/diff/文件夹、右边 inspector。
//
// inspector 用真的 `InspectorHost`：面板一个个关掉，关掉最后一个时整条从 DOM 里消失——
// 那条卸载路径正是放大层挤成细条那个 bug 的触发点，手搓一个永不卸载的壳就永远测不到它。
// 三个共用放大层的查看器（全文、单文件 diff、文件夹详情）都挂在这里，一处修好三处都得跟上。
function Fixture() {
  const view = useFileView(TASK_ID);
  // 重开面板的入口在底部坞里：放大层盖住整个主区，底部坞是它永远让开的那一条。
  const openTab = useRef<((id: string) => void) | null>(null);

  return (
    <div className="workspace-system-layout" style={{ height: "100vh" }}>
      <div />
      <div className="workspace-shell">
        <aside id="fixture-rail" style={{ width: 220, minWidth: 220, background: "var(--chrome)", padding: 12 }}>
          任务栏
        </aside>
        <div style={{ display: "flex", minWidth: 0, flex: 1, isolation: "isolate", position: "relative" }}>
          <InspectorHost
            contextKey="file-view-zoom-fixture"
            context={null}
            descriptors={[
              {
                id: "files",
                title: "文件",
                icon: <TreeStructure size={15} aria-hidden="true" />,
                defaultOpen: true,
                render: () => (
                  <FileTreeInspector
                    notify={() => undefined}
                    taskId={TASK_ID}
                    activePath={view.activePath}
                    onOpenFile={view.openFile}
                    onOpenDiff={view.openDiff}
                    onOpenFolder={view.openFolder}
                  />
                ),
              },
              {
                id: "notes",
                title: "备忘",
                icon: <FolderOpen size={15} aria-hidden="true" />,
                defaultOpen: true,
                render: () => <p style={{ padding: 10 }}>这一轮没有备忘。</p>,
              },
            ]}
          >
            {(controls) => {
              openTab.current = controls.openTab;
              return (
                <div className="inspector-layout__main" id="fixture-main">
                  {view.filePath ? (
                    <FileViewer
                      taskId={TASK_ID}
                      path={view.filePath}
                      zoomed={view.zoomed}
                      onToggleZoom={view.toggleZoom}
                      onExitZoom={view.exitZoom}
                      onOpenDiff={view.canShowDiff ? view.showDiff : undefined}
                      onClose={view.close}
                      notify={() => undefined}
                    />
                  ) : view.folderPath ? (
                    <FolderViewer
                      taskId={TASK_ID}
                      path={view.folderPath}
                      zoomed={view.zoomed}
                      onToggleZoom={view.toggleZoom}
                      onExitZoom={view.exitZoom}
                      onOpenFile={view.openFile}
                      onOpenFolder={view.openFolder}
                      onClose={view.close}
                      notify={() => undefined}
                    />
                  ) : view.diff ? (
                    <ScmDiffViewer
                      taskId={TASK_ID}
                      path={view.diff.path}
                      source={view.diff.source}
                      origPath={view.diff.origPath}
                      kind={view.diff.kind}
                      zoomed={view.zoomed}
                      onToggleZoom={view.toggleZoom}
                      onExitZoom={view.exitZoom}
                      onOpenFile={view.showFile}
                      onClose={view.close}
                    />
                  ) : (
                    <p data-testid="center-empty" style={{ margin: "auto", color: "var(--faint)" }}>会话</p>
                  )}
                </div>
              );
            }}
          </InspectorHost>
        </div>
      </div>
      {/* 底部坞：终端（收起时不占行）压在全局状态栏上。高度由测试改，模拟拖高终端。 */}
      <div
        id="fixture-dock"
        style={{ display: "flex", height: 36, alignItems: "center", gap: 8, background: "var(--chrome)", borderTop: ".5px solid var(--line)", padding: "0 8px" }}
      >
        状态栏
        {/* 一颗按钮把两格都开回来：测里那一串「关光再重开」要能反复走，每一轮都得从同样的
            起点开始。真实页面上也是一个个点开的，这里只是把两下并成一下。 */}
        <button
          type="button"
          onClick={() => { openTab.current?.("notes"); openTab.current?.("files"); }}
        >
          重开右侧面板
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
