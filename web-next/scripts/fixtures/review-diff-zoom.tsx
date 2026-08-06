import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { TaskDiffResult } from "../../src/lib/api.ts";
import { ReviewDiffViewer } from "../../src/review/ReviewDiffViewer.tsx";
import { ConfirmDialog } from "../../src/task-detail/ConfirmDialog.tsx";
import "../../src/styles/global.css";

const diff: TaskDiffResult = {
  available: true,
  sourceBranch: "harness/zoom",
  targetBranch: "main",
  mergeBase: "abcdef0123456789",
  files: [
    { path: "web-next/src/review/ReviewDiffViewer.tsx", additions: 24, deletions: 3 },
    { path: "web-next/src/styles/review.css", additions: 9, deletions: 1 },
  ],
  diff: [
    "diff --git a/web-next/src/review/ReviewDiffViewer.tsx b/web-next/src/review/ReviewDiffViewer.tsx",
    "--- a/web-next/src/review/ReviewDiffViewer.tsx",
    "+++ b/web-next/src/review/ReviewDiffViewer.tsx",
    "@@ -1,3 +1,4 @@",
    " import { useMemo } from \"react\";",
    "+import { createPortal } from \"react-dom\";",
    " export function ReviewDiffViewer() {",
    "-  return null;",
    "diff --git a/web-next/src/styles/review.css b/web-next/src/styles/review.css",
    "--- a/web-next/src/styles/review.css",
    "+++ b/web-next/src/styles/review.css",
    "@@ -1,2 +1,3 @@",
    " .single-review-diff { min-width: 0; }",
    "+.review-zoom-layer { position: fixed; inset: 0; }",
  ].join("\n"),
  truncated: false,
  limitBytes: 1024 * 1024,
};

// 主工作区在真实页面里自成一个堆叠上下文（sidebar-spread.css 的 isolation:isolate），
// 所以放大层留在原地时，z-index 再大也盖不住右边这条侧边栏。fixture 照抄这层约束，
// 「盖住整屏」才测得出来。
function Fixture() {
  const [confirming, setConfirming] = useState(false);
  // 放大层铺满整屏，鼠标点不到它外面的东西；真实里「放大着又弹出确认框」走的是别的路径
  // （快捷键、后开的抽屉里点验收、服务端事件）。这里用一个按键代表那条路径，免得测试靠
  // 程序化点击穿透遮挡——那种点击在真实交互里根本发生不了。
  useEffect(() => {
    const open = (event: KeyboardEvent) => { if (event.key === "c") setConfirming(true); };
    window.addEventListener("keydown", open);
    return () => window.removeEventListener("keydown", open);
  }, []);
  return (
    <div style={{ display: "flex", height: 640 }}>
      <main style={{ minWidth: 0, flex: 1, isolation: "isolate", zIndex: 5, padding: 12 }}>
        <ReviewDiffViewer result={diff} />
      </main>
      <aside
        id="fixture-sidebar"
        style={{ zIndex: 90, width: 300, minWidth: 300, background: "var(--panel)", padding: 12 }}
      >
        <button type="button" onClick={() => setConfirming(true)}>验收通过</button>
      </aside>
      {confirming && (
        <ConfirmDialog
          title="确认验收通过？"
          message="这会把任务分支合并回 main。"
          confirmLabel="验收通过"
          onConfirm={() => setConfirming(false)}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
