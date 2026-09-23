import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { FileTreeInspector } from "../../src/files/FileTreeInspector.tsx";
import { FileViewer } from "../../src/files/FileViewer.tsx";
import { FolderViewer } from "../../src/files/FolderViewer.tsx";
import { useFileView } from "../../src/files/useFileView.ts";
import "../../src/styles/global.css";

const TASK_ID = "task-1";

// 删除入口那条路的最小接线：文件树在左，中间栏摊文件全文或文件夹详情。
// TaskDetail 和 TeamView 接的是同一套（`useFileView` + 这两个视图 + `onOpenFolder`），
// 这里钉「点开文件夹详情 → 删除 → 树上那一行消失」整条链。
function Fixture() {
  const view = useFileView(TASK_ID);
  const [notices, setNotices] = useState<string[]>([]);
  const notify = (message: string) => setNotices((current) => [...current, message]);

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
          onOpenFolder={view.openFolder}
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
            onClose={view.close}
            notify={notify}
          />
        ) : view.folderPath ? (
          <FolderViewer
            taskId={TASK_ID}
            path={view.folderPath}
            onOpenFile={view.openFile}
            onOpenFolder={view.openFolder}
            onClose={view.close}
            notify={notify}
          />
        ) : (
          <p data-testid="center-empty" style={{ margin: "auto", color: "var(--faint)" }}>会话</p>
        )}
      </div>
      <ul data-testid="notices" style={{ position: "fixed", right: 8, bottom: 8, margin: 0, listStyle: "none", font: "11px var(--font)" }}>
        {notices.map((notice, index) => <li key={index}>{notice}</li>)}
      </ul>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
