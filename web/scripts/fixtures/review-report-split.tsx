// 审查报告摘要/明细折叠的 DOM fixture：把每一种已知形态并排挂出来。
//
// 并排是必须的：这个改动真正的风险不是「折叠不灵」，而是**对不上契约的报告被误拆、
// 内容被藏进一个宣称里面只有合规证明的按钮里**。几种形态同屏才能一眼看出降级行为——
// 存量报告拆在第一个 `##` 之前、按钮只写「展开完整报告」，认不出摘要的按高度夹住。
//
// 报告正文在 `review-report-texts.ts`：那一份只增不改（每轮抓到一种新形态就多一份），
// 这一份只负责挂载。合在一起写到 684 行（上限 700）就该拆了。
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReviewReportBody } from "../../src/components/MarkdownBody.tsx";
import {
  conforming,
  conformingRound2,
  legacy,
  fenced,
  commented,
  quoted,
  proseCopy,
  reordered,
  wrongHeading,
  problemAsHeading,
  legacyConclusion,
  headingColumns,
  englishConclusion,
  negatedNoProblem,
  nonProblemHeading,
  findingsReport,
  countsShort,
  severityFirst,
  metadataFirst,
  justOver,
  contradictoryNone,
  spilled,
} from "./review-report-texts.ts";
import "../../src/styles/global.css";

// 第三、四块：在**同一个位置**换报告，模拟侧栏抽屉切换轮次。展开状态如果是独立 state，
// 换一轮就会串过去——下一份报告一打开就是满屏命令输出，恰好是这个改动要消灭的东西。
//
// `identical` 那一份是边界：**两轮报告一字不差**（同一处没修好、原样重报一遍）。按正文
// 判「换了没有」在这里认不出来，所以复位判据必须是报告身份 `reportKey`。
function SwitchableReport({ identical = false }: { identical?: boolean }) {
  const [second, setSecond] = useState(false);
  return (
    <>
      <button type="button" className="switch-round" onClick={() => setSecond((value) => !value)}>
        切换轮次
      </button>
      <ReviewReportBody
        text={!second || identical ? conforming : conformingRound2}
        reportKey={`run-1:${second ? 2 : 1}`}
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="conforming-fixture markdown-report-body">
      <ReviewReportBody text={conforming} reportKey="run-1:4" />
    </div>
    <div className="legacy-fixture markdown-report-body">
      <ReviewReportBody text={legacy} reportKey="run-2:1" />
    </div>
    {/* Windows 上生成的同一份报告：换行是 CRLF，屏幕上该长得一模一样。 */}
    <div className="crlf-fixture markdown-report-body">
      <ReviewReportBody text={conforming.replace(/\n/g, "\r\n")} reportKey="run-3:1" />
    </div>
    <div className="fence-fixture markdown-report-body">
      <ReviewReportBody text={fenced} reportKey="run-4:6" />
    </div>
    <div className="comment-fixture markdown-report-body">
      <ReviewReportBody text={commented} reportKey="run-5:7" />
    </div>
    <div className="quoted-fixture markdown-report-body">
      <ReviewReportBody text={quoted} reportKey="run-6:8" />
    </div>
    <div className="prose-copy-fixture markdown-report-body">
      <ReviewReportBody text={proseCopy} reportKey="run-7:9" />
    </div>
    <div className="reordered-fixture markdown-report-body">
      <ReviewReportBody text={reordered} reportKey="run-8:9" />
    </div>
    <div className="wrong-heading-fixture markdown-report-body">
      <ReviewReportBody text={wrongHeading} reportKey="run-9:10" />
    </div>
    <div className="problem-heading-fixture markdown-report-body">
      <ReviewReportBody text={problemAsHeading} reportKey="run-10:10" />
    </div>
    <div className="legacy-conclusion-fixture markdown-report-body">
      <ReviewReportBody text={legacyConclusion} reportKey="run-11:1" />
    </div>
    <div className="heading-columns-fixture markdown-report-body">
      <ReviewReportBody text={headingColumns} reportKey="run-12:3" />
    </div>
    <div className="english-conclusion-fixture markdown-report-body">
      <ReviewReportBody text={englishConclusion} reportKey="run-13:1" />
    </div>
    <div className="negated-fixture markdown-report-body">
      <ReviewReportBody text={negatedNoProblem} reportKey="run-14:4" />
    </div>
    <div className="non-problem-heading-fixture markdown-report-body">
      <ReviewReportBody text={nonProblemHeading} reportKey="run-15:5" />
    </div>
    <div className="findings-fixture markdown-report-body">
      <ReviewReportBody text={findingsReport} reportKey="run-16:1" />
    </div>
    <div className="counts-short-fixture markdown-report-body">
      <ReviewReportBody text={countsShort} reportKey="run-17:1" />
    </div>
    <div className="severity-first-fixture markdown-report-body">
      <ReviewReportBody text={severityFirst} reportKey="run-18:1" />
    </div>
    <div className="metadata-first-fixture markdown-report-body">
      <ReviewReportBody text={metadataFirst} reportKey="run-19:1" />
    </div>
    <div className="just-over-fixture markdown-report-body" style={{ width: 720 }}>
      <ReviewReportBody text={justOver} reportKey="run-20:1" />
    </div>
    <div className="contradictory-none-fixture markdown-report-body">
      <ReviewReportBody text={contradictoryNone} reportKey="run-21:1" />
    </div>
    <div className="spilled-fixture markdown-report-body">
      <ReviewReportBody text={spilled} reportKey="run-22:1" />
    </div>
    <div className="switch-fixture markdown-report-body">
      <SwitchableReport />
    </div>
    <div className="identical-fixture markdown-report-body">
      <SwitchableReport identical />
    </div>
  </StrictMode>,
);
