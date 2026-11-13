// 「过了保留期被删掉的审查截图」在界面上长什么样的 DOM fixture（判据见
// src/free-workflow/expiredEvidence.ts）。
//
// 报告里引用它的三种写法都要认出来：相对路径的内嵌图、指向它的链接、绝对路径改写过来的那一种；
// 还在的那张照常画。截图条有两种：删了一部分、全删了。过期登记**晚于首次渲染**才到——真实页面上
// 报告和自由工作流状态是两次请求，谁先到不一定。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ReviewReportBody } from "../../src/components/MarkdownBody.tsx";
import { reportFileResolver } from "../../src/components/markdownPolicy.ts";
import { recordExpiredEvidence } from "../../src/free-workflow/expiredEvidence.ts";
import { api } from "../../src/lib/api.ts";
import { ReviewScreenshotStrip } from "../../src/review/ReviewScreenshotStrip.tsx";
import type { FreeWorkflowApiState } from "../../src/lib/api.ts";
import "../../src/styles/global.css";

const fileUrl = (name: string) => api.freeReviewFileUrl("T9", "R9", 1, name);

const REPORT = [
  "## 结论",
  "",
  "能。",
  "",
  "![复现截图](a.png)",
  "",
  "对照见 [第二张](shots/b.png)。",
  "",
  "![绝对路径](/Users/demo/ash/data/runs/T9/free-review/R9/round-1/c.png)",
  "",
  "![还在](kept.png)",
].join("\n");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <section className="expired-report">
      <ReviewReportBody text={REPORT} reportKey="R9:1" conclusion="verified" resolveFile={reportFileResolver(fileUrl, "T9")} />
    </section>
    <section className="strip-partial">
      <ReviewScreenshotStrip expired={3} items={[{ key: "kept.png", name: "kept.png", src: fileUrl("kept.png"), label: "kept.png" }]} />
    </section>
    <section className="strip-all">
      <ReviewScreenshotStrip expired={3} items={[]} />
    </section>
  </StrictMode>,
);

const state = {
  reviews: [{ id: "R9", rounds: [{ round: 1, screenshots: ["kept.png"], expiredScreenshots: ["a.png", "c.png", "shots/b.png"] }] }],
} as unknown as Pick<FreeWorkflowApiState, "reviews">;
setTimeout(() => recordExpiredEvidence("T9", state), 400);
