import { StrictMode, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import type { TaskDiffResult } from "../../src/lib/api.ts";
import { ReviewDiffViewer } from "../../src/review/ReviewDiffViewer.tsx";
import { ConfirmDialog } from "../../src/task-detail/ConfirmDialog.tsx";
import "../../src/styles/global.css";

const diff: TaskDiffResult = {
  available: true,
  sourceBranch: "ash/zoom",
  targetBranch: "main",
  mergeBase: "abcdef0123456789",
  files: [
    { path: "web/src/review/ReviewDiffViewer.tsx", additions: 24, deletions: 3 },
    { path: "web/src/styles/review.css", additions: 9, deletions: 1 },
  ],
  diff: [
    "diff --git a/web/src/review/ReviewDiffViewer.tsx b/web/src/review/ReviewDiffViewer.tsx",
    "--- a/web/src/review/ReviewDiffViewer.tsx",
    "+++ b/web/src/review/ReviewDiffViewer.tsx",
    "@@ -1,3 +1,4 @@",
    " import { useMemo } from \"react\";",
    "+import { createPortal } from \"react-dom\";",
    " export function ReviewDiffViewer() {",
    "-  return null;",
    "diff --git a/web/src/styles/review.css b/web/src/styles/review.css",
    "--- a/web/src/styles/review.css",
    "+++ b/web/src/styles/review.css",
    "@@ -1,2 +1,3 @@",
    " .single-review-diff { min-width: 0; }",
    "+.review-zoom-layer { position: fixed; inset: 0; }",
  ].join("\n"),
  truncated: false,
  limitBytes: 1024 * 1024,
};

// 复刻真实页面的三段布局：左边任务栏、中间主区（sidebar-spread.css 给它 isolation:isolate，
// 自成一个堆叠上下文）、右边 inspector（挂在主区里面）。两条约束都靠这个结构才测得出来：
// 放大层留在原地盖不住任务栏，所以必须 portal；inspector 又在主区那个上下文里，portal 之后
// 单靠 z-index 一定会把它也盖掉，所以只能靠让出宽度。
//
// 外层那圈 padding 抄的是 `.workspace-shell`（`workspace.css`）：右边 8px 让 inspector 差
// 这么一点没贴到窗口右缘。别当它是装饰——第一版就是在这 8px 上翻的车：让位的判据要求右缘
// 严丝合缝对齐窗口，fixture 恰好对齐所以全绿，真实页面里一条都找不到，放大照样盖住 inspector。
function Fixture() {
  const [confirming, setConfirming] = useState(false);
  return (
    <div style={{ display: "flex", height: 640, padding: "8px 8px 8px 0" }}>
      <aside id="fixture-rail" style={{ width: 220, minWidth: 220, background: "var(--chrome)", padding: 12 }}>
        任务栏
      </aside>
      <div style={{ display: "flex", minWidth: 0, flex: 1, isolation: "isolate", position: "relative" }}>
        <div className="inspector-layout">
          <div className="inspector-layout__main" id="fixture-main" style={{ padding: 12 }}>
            <ReviewDiffViewer result={diff} />
          </div>
          <aside
            id="fixture-inspector"
            className="inspector-host"
            style={{ "--inspector-width": "300px" } as CSSProperties}
          >
            <button type="button" onClick={() => setConfirming(true)}>验收通过</button>
          </aside>
        </div>
        {/* 团队的执行者抽屉：里面还嵌着一份 TaskDetail，也能放大它的 diff。抽屉自己是
            z-index 95，放大层要抬到它上面，同时让开的仍是窗口右缘那条 inspector。 */}
        <div id="fixture-drawer" className="team-worker-drawer" style={{ padding: 12 }}>
          <ReviewDiffViewer result={diff} />
        </div>
      </div>
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
