// 「过了保留期被删掉的审查截图」在界面上长什么样的 DOM fixture（判据见
// src/free-workflow/expiredEvidence.ts）。
//
// 报告里引用它的几种写法都要认出来：相对路径的内嵌图、指向它的链接、绝对路径改写过来的那一种、
// 等价参数写法的证据地址（`round=01`、`shots\b.png`）；还在的那张照常画。截图条有两种：删了一部分、
// 全删了。
//
// 页面上**一次都没读过** T9 的自由工作流状态（审查第 1 轮 F2：从别的任务里点开旧报告）——过期
// 清单只能按证据地址里的任务编号现取。T8 那份报告演的是清单过时：第一次取到的清单还是空的
// （页面打开之后清扫才跑），图片加载失败时要重取、改口成「已过保留期」。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ReviewReportBody } from "../../src/components/MarkdownBody.tsx";
import { reportFileResolver } from "../../src/components/markdownPolicy.ts";
import { api } from "../../src/lib/api.ts";
import { ReviewScreenshotStrip } from "../../src/review/ReviewScreenshotStrip.tsx";
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
  "",
  "![别名](/api/tasks/T9/free-workflow/review-file?run=R9&round=01&name=shots%5Cb.png)",
].join("\n");

const STALE_REPORT = ["## 结论", "", "能。", "", "![刚清掉](late.png)"].join("\n");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <section className="expired-report">
      <ReviewReportBody text={REPORT} reportKey="R9:1" conclusion="verified" resolveFile={reportFileResolver(fileUrl, "T9")} />
    </section>
    <section className="stale-report">
      <ReviewReportBody text={STALE_REPORT} reportKey="R8:1" conclusion="verified"
        resolveFile={reportFileResolver((name) => api.freeReviewFileUrl("T8", "R8", 1, name), "T8")} />
    </section>
    <section className="strip-partial">
      <ReviewScreenshotStrip expired={3} items={[{ key: "kept.png", name: "kept.png", src: fileUrl("kept.png"), label: "kept.png" }]} />
    </section>
    <section className="strip-all">
      <ReviewScreenshotStrip expired={3} items={[]} />
    </section>
  </StrictMode>,
);

