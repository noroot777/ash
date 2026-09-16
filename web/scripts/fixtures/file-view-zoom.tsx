import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { CSSProperties } from "react";
import { FileTreeInspector } from "../../src/files/FileTreeInspector.tsx";
import { FileViewer } from "../../src/files/FileViewer.tsx";
import { useFileView } from "../../src/files/useFileView.ts";
import { ScmDiffViewer } from "../../src/scm/ScmDiffViewer.tsx";
import "../../src/styles/global.css";

const TASK_ID = "task-1";

// 复刻真实页面的三段布局（同 `review-diff-zoom.tsx`）：左边任务栏、中间摊开的文件/diff、
// 右边挂着文件树的 inspector。放大要盖住任务栏、让开 inspector，两条都得有这个结构才测得出。
// 外层那圈 padding 抄的是 `.workspace-shell`：右边 8px 让 inspector 差一点没贴到窗口右缘。
function Fixture() {
  const view = useFileView(TASK_ID);

  return (
    <div style={{ display: "flex", height: 640, padding: "8px 8px 8px 0" }}>
      <aside id="fixture-rail" style={{ width: 220, minWidth: 220, background: "var(--chrome)", padding: 12 }}>
        任务栏
      </aside>
      <div style={{ display: "flex", minWidth: 0, flex: 1, isolation: "isolate", position: "relative" }}>
        <div className="inspector-layout">
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
          <aside
            id="fixture-inspector"
            className="inspector-host"
            style={{ "--inspector-width": "300px" } as CSSProperties}
          >
            <FileTreeInspector
              taskId={TASK_ID}
              activePath={view.activePath}
              onOpenFile={view.openFile}
              onOpenDiff={view.openDiff}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
