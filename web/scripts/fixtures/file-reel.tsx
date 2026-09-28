import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { CSSProperties } from "react";
import { ArtifactsInspector } from "../../src/files/ArtifactsInspector.tsx";
import { FileViewer } from "../../src/files/FileViewer.tsx";
import { useFileView } from "../../src/files/useFileView.ts";
import "../../src/styles/global.css";

const TASK_ID = "task-1";

// 真实页面的两段：中间摊开一份产物，右边是生成物面板。翻页的那一串由面板在点开那一刻
// 给出（同一组的全部路径），所以两边必须都在，光挂一个查看器测不出。
function Fixture() {
  const view = useFileView(TASK_ID);

  return (
    <div style={{ display: "flex", height: 640 }}>
      <div className="inspector-layout">
        <div className="inspector-layout__main" id="fixture-main">
          {view.filePath ? (
            <FileViewer
              taskId={TASK_ID}
              path={view.filePath}
              reel={view.reel}
              onStep={view.stepFile}
              onClose={view.close}
              notify={() => undefined}
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
          <ArtifactsInspector
            taskId={TASK_ID}
            activePath={view.activePath}
            onOpenFile={view.openFile}
            notify={() => undefined}
          />
          {/* 侧栏里随便一个输入框：翻页键不能在人打字的时候把图翻走。 */}
          <input id="fixture-input" aria-label="侧栏输入框" />
        </aside>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
