// 「过了保留期被删掉的审查截图」在界面上长什么样的 DOM fixture（判据见
// src/free-workflow/expiredEvidence.ts）。
//
// 报告里引用它的几种写法都要认出来：相对路径的内嵌图、指向它的链接、绝对路径改写过来的那一种、
// 等价参数写法的证据地址（`round=01`、`shots\b.png`）；还在的那张照常画。截图条有两种：删了一部分、
// 全删了。
//
// 页面上**一次都没读过**这些任务的自由工作流状态（审查第 1 轮 F2：从别的任务里点开旧报告）——
// 过期清单只能按证据地址里的任务编号现取。另外几份报告演的是这份副本怎么过时（审查第 2 轮）：
//   T8 第一次取到的清单还是清扫前的，内嵌图取不到时要重取、改口；
//   T7 只有一条图片链接，清单已经取过（空的），之后才清扫——点开灯箱要说「已过保留期」，不是裂图；
//   T6 过期之后图又回来了——关掉报告再打开，要把图画出来，不能一直说过期；
//   T5 整份状态先报了过期，更早发出的那趟清单才迟到——旧的不许盖新的。
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReviewReportBody } from "../../src/components/MarkdownBody.tsx";
import { reportFileResolver } from "../../src/components/markdownPolicy.ts";
import { recordExpiredEvidence } from "../../src/free-workflow/expiredEvidence.ts";
import { api, type FreeWorkflowApiState } from "../../src/lib/api.ts";
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


function Report({ task, text }: { task: string; text: string }) {
  return (
    <ReviewReportBody text={["## 结论", "", "能。", "", text].join("\n")} reportKey={`R${task}:1`} conclusion="verified"
      resolveFile={reportFileResolver((name) => api.freeReviewFileUrl(`T${task}`, `R${task}`, 1, name), `T${task}`)} />
  );
}

/** 「关掉报告再打开」：测试脚本调 window.__toggleT6()。 */
function Reopenable() {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    (window as unknown as { __toggleT6: () => void }).__toggleT6 = () => setOpen((value) => !value);
  }, []);
  return open ? <Report task="6" text="![回来了](r.png)" /> : null;
}

/** 整份状态这一路：测试脚本调 window.__recordT5()，等于 useFreeWorkflowState 收下了一份新状态。 */
(window as unknown as { __recordT5: () => void }).__recordT5 = () => recordExpiredEvidence("T5", {
  stateVersion: 3,
  reviews: [{ id: "R5", rounds: [{ round: 1, screenshots: [], expiredScreenshots: ["z.png"] }] }],
} as unknown as Pick<FreeWorkflowApiState, "reviews" | "stateVersion">);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <section className="expired-report">
      <ReviewReportBody text={REPORT} reportKey="R9:1" conclusion="verified" resolveFile={reportFileResolver(fileUrl, "T9")} />
    </section>
    <section className="stale-report"><Report task="8" text="![刚清掉](late.png)" /></section>
    <section className="link-report"><Report task="7" text="[查看截图](x.png)" /></section>
    <section className="reopen-report"><Reopenable /></section>
    <section className="race-report"><Report task="5" text="![后到的旧清单](z.png)" /></section>
    <section className="strip-partial">
      <ReviewScreenshotStrip expired={3} items={[{ key: "kept.png", name: "kept.png", src: fileUrl("kept.png"), label: "kept.png" }]} />
    </section>
    <section className="strip-all">
      <ReviewScreenshotStrip expired={3} items={[]} />
    </section>
  </StrictMode>,
);

