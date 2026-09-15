import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FileTreeInspector } from "../../src/files/FileTreeInspector.tsx";
import { FileViewer } from "../../src/files/FileViewer.tsx";
import { useFileView } from "../../src/files/useFileView.ts";
import { ScmDiffViewer } from "../../src/scm/ScmDiffViewer.tsx";
import "../../src/styles/global.css";

const TASK_ID = "task-1";

// 中间栏那一块的最小接线：文件树在左，摊开的东西在右。
// 单飞任务（TaskDetail）和团队调度台（TeamView）接的是同一套，这里只钉「文件 ↔ diff」这条路。
function Fixture() {
  const view = useFileView(TASK_ID);

  return (
    <main style={{ display: "flex", gap: 16, padding: 20, height: "100%", boxSizing: "border-box" }}>
      <div
        data-testid="file-tree-host"
        style={{ width: 320, height: 620, overflow: "hidden", border: "1px solid var(--line2)", borderRadius: 10, background: "var(--panel)" }}
      >
        <FileTreeInspector
          taskId={TASK_ID}
          activePath={view.activePath}
          onOpenFile={view.openFile}
          onOpenDiff={view.openDiff}
        />
      </div>
      <div
        data-testid="center"
        style={{ flex: 1, height: 620, overflow: "hidden", border: "1px solid var(--line2)", borderRadius: 10, background: "var(--panel)", display: "flex" }}
      >
        {view.filePath ? (
          <FileViewer
            taskId={TASK_ID}
            path={view.filePath}
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
            onOpenFile={view.showFile}
            onClose={view.close}
          />
        ) : (
          <p data-testid="center-empty" style={{ margin: "auto", color: "var(--faint)" }}>会话</p>
        )}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
