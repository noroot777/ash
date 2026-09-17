import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { TaskDiffResult } from "../../src/lib/api.ts";
import { ReviewDiffViewer } from "../../src/review/ReviewDiffViewer.tsx";
import "../../src/styles/global.css";

// 审查页「改动文件」轨的夹具：只摆这一个组件，路径造得有层级，够测目录树。
// （放大层那条约束另有 review-diff-zoom 夹具，那边还叠了抽屉，不适合拿来点文件。）

const section = (path: string) => [
  `diff --git a/${path} b/${path}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  "@@ -1,2 +1,3 @@",
  " const a = 1;",
  `+// ${path}`,
].join("\n");

const files = [
  { path: "server/scripts/test-chat-review.ts", additions: 5, deletions: 5, origPath: null },
  { path: "server/src/chat/context.ts", additions: 5, deletions: 2, origPath: null },
  { path: "server/src/chat/service.ts", additions: 5, deletions: 2, origPath: null },
  { path: "README.md", additions: 1, deletions: 0, origPath: null },
];

const diff: TaskDiffResult = {
  available: true,
  sourceBranch: "ash/tree",
  targetBranch: "main",
  mergeBase: "abcdef0123456789",
  files,
  diff: files.map((file) => section(file.path)).join("\n"),
  truncated: false,
  limitBytes: 1024 * 1024,
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ padding: 12 }}>
      <ReviewDiffViewer result={diff} />
    </div>
  </StrictMode>,
);
