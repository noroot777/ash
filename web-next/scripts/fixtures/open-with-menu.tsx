import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { OpenWithMenu } from "../../src/files/OpenWithMenu.tsx";
import "../../src/styles/global.css";

// StrictMode 是刻意的：这个组件栽过一次「effect 自己触发自己 → cleanup 作废在途请求
// → 菜单永远停在加载态」，StrictMode 的双跑正是最容易把那类写法照出来的地方。
function Harness() {
  const [path, setPath] = useState("AGENTS.md");
  const [toast, setToast] = useState("");
  return (
    <main className="file-viewer" style={{ width: 520, height: 260 }}>
      <header className="file-viewer__bar">
        <div className="file-viewer__title"><b>{path}</b></div>
        <OpenWithMenu taskId="fixture-task" path={path} notify={setToast} />
        <button type="button" className="file-viewer__action" onClick={() => setPath("readme.md")}>
          换文件
        </button>
      </header>
      <p data-testid="toast">{toast}</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
