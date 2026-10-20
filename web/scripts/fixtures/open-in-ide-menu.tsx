import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { FolderViewer } from "../../src/files/FolderViewer.tsx";
import { OpenInIdeMenu } from "../../src/files/OpenInIdeMenu.tsx";
import "../../src/styles/global.css";

// 两块各钉一件事：
//  · 上面那块是**真的** FolderViewer，塞进一条 420px 宽的中间栏里——新加的 IDE 按钮把
//    工具条挤爆过，标题被压成零宽、「关闭」整个溢出到面板外（第 2 轮审查 N1）。
//  · 下面那块是单独的菜单，用来验启动回执的措辞和探测卡住时的出路（F2 的界面那一半、N3）。
// StrictMode 是刻意的：探测那套「在途去重 + 结果缓存」最容易在双跑下露馅。
function Ash() {
  const [toast, setToast] = useState("");
  const [closed, setClosed] = useState(false);
  return (
    <main style={{ display: "grid", gap: 16, padding: 8 }}>
      <div data-testid="narrow-panel" style={{ width: 420, height: 320, display: "flex", overflow: "hidden" }}>
        {!closed && (
          <FolderViewer
            taskId="fixture-task"
            path="src"
            onOpenFile={() => {}}
            onOpenFolder={() => {}}
            onClose={() => setClosed(true)}
            notify={setToast}
          />
        )}
      </div>
      <div className="file-viewer" style={{ width: 520 }}>
        <header className="file-viewer__bar">
          <div className="file-viewer__title"><b>单独的菜单</b></div>
          <OpenInIdeMenu taskId="fixture-task" path="src" notify={setToast} />
        </header>
      </div>
      <p data-testid="toast">{toast}</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Ash />
  </StrictMode>,
);
