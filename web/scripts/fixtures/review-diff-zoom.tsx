import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ClipboardText, GitDiff } from "@phosphor-icons/react";
import { InspectorHost } from "../../src/inspector/InspectorHost.tsx";
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
    "+.zoom-layer { position: fixed; inset: 0; }",
  ].join("\n"),
  truncated: false,
  limitBytes: 1024 * 1024,
};

// 复刻真实页面的整套外壳（`WorkspaceShell` 那三分支共用的那一套）：
//
// - `.workspace-system-layout` 的网格里，工作区那一行上面是入站申请位、下面是横贯窗口的
//   底部坞（终端 + 全局状态栏）。放大层的下缘按工作区那一行的下缘算，所以这一行真实存在、
//   真实会被终端挤矮，才测得出「开合/拖高终端时跟着变」。
// - 工作区那一行里：左边任务栏、中间主区（`sidebar-spread.css` 给它 isolation:isolate，
//   自成一个堆叠上下文）、右边 inspector。两条约束都靠这个结构才测得出来：放大层留在原地
//   盖不住任务栏，所以必须 portal；inspector 又在主区那个上下文里，portal 之后单靠 z-index
//   一定会把它也盖掉，所以只能靠让出宽度。
// - inspector 用真的 `InspectorHost`，不是手搓一个常驻 `<aside class="inspector-host">`：
//   面板是一个个关掉的，关掉最后一个时**整条 inspector 从 DOM 里消失**（`activeDescriptor`
//   为空就整块不渲染）。那条卸载路径正是放大层挤成细条那个 bug 的触发点，手搓一个永不卸载
//   的壳就永远测不到它。
//
// `.workspace-shell` 右边自带 8px 内边距，inspector 因此差一点没贴到窗口右缘。别当它是装饰
// ——第一版就是在这 8px 上翻的车：让位的判据要求右缘严丝合缝对齐窗口，手抄的 fixture 恰好
// 对齐所以全绿，真实页面里一条都找不到，放大照样盖住 inspector。
function Fixture() {
  const [confirming, setConfirming] = useState(false);
  // 抽屉按需打开，不常驻：它 z-index 95、`left:0` 起宽 680px，常驻时会盖住 inspector 左缘
  // 那条宽度把手（真实页面上也一样，所以那是抽屉自己的事，不该让它妨碍主路径的测量）。
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 重开面板的入口得放在底部坞里：放大层盖住整个主区，而底部坞是它永远让开的那一条——
  // 真实页面上的全局状态栏同理，放大着也点得到。`openTab` 是稳定引用，借 render prop 递出来。
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
            contextKey="review-diff-zoom-fixture"
            context={null}
            descriptors={[
              {
                id: "evidence",
                title: "审查记录",
                icon: <ClipboardText size={15} aria-hidden="true" />,
                defaultOpen: true,
                render: () => (
                  <button type="button" onClick={() => setConfirming(true)}>验收通过</button>
                ),
              },
              {
                id: "changes",
                title: "改动与提交",
                icon: <GitDiff size={15} aria-hidden="true" />,
                defaultOpen: true,
                render: () => <p style={{ padding: 10 }}>这一轮改了两个文件。</p>,
              },
            ]}
          >
            {(controls) => {
              openTab.current = controls.openTab;
              return (
                <div className="inspector-layout__main" id="fixture-main" style={{ padding: 12 }}>
                  <ReviewDiffViewer result={diff} />
                </div>
              );
            }}
          </InspectorHost>
          {/* 团队的执行者抽屉：里面还嵌着一份 TaskDetail，也能放大它的 diff。抽屉自己是
              z-index 95，放大层要抬到它上面，同时让开的仍是窗口右缘那条 inspector。 */}
          {drawerOpen && (
            <div id="fixture-drawer" className="side-drawer side-drawer--worker" style={{ padding: 12 }}>
              <ReviewDiffViewer result={diff} />
            </div>
          )}
        </div>
      </div>
      {/* 底部坞：终端（收起时不占行）压在全局状态栏上。高度由测试改，模拟拖高终端。 */}
      <div
        id="fixture-dock"
        style={{ display: "flex", height: 36, alignItems: "center", gap: 8, background: "var(--chrome)", borderTop: ".5px solid var(--line)", padding: "0 8px" }}
      >
        状态栏
        <button type="button" onClick={() => openTab.current?.("evidence")}>重开审查记录</button>
        <button type="button" onClick={() => setDrawerOpen(true)}>打开执行者抽屉</button>
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
