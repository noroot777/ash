import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ScmInspector } from "../../src/scm/ScmInspector.tsx";
import "../../src/styles/global.css";

// 「写操作落地了，但补刷状态读不到」这一档的回归夹具。后端在 scm-routes.ts 里把写成功
// 之后那次 readScmStatus 降级成了可选（成功绝不能被状态读失败翻成失败），面板因此可能
// 停在一份写之前的列表上——这里就是造那个局面：写响应不带 status，随后的 GET 也失败。

function Ash() {
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <div className="inspector-host" style={{ width: 360 }}>
      <ScmInspector
        taskId="t1"
        activeDiff={null}
        onOpenDiff={() => {}}
        notify={(message) => setNotice(message)}
      />
      <p id="notice">{notice ?? ""}</p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Ash />
  </StrictMode>,
);
