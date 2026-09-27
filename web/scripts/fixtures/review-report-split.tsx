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
  sixProblems,
  fiveProblems,
  contradictoryUncounted,
  problemAtBoundary,
  hiddenDeepProblem,
  softDeniedVerdict,
  pendingAcceptance,
  englishVerdict,
  contradictedTail,
  revokedVerdict,
  hedgedVerdict,
  narrowedScope,
  unfinishedVerdict,
  invisibleProblem,
  decoratedVerdict,
  imageAltProblem,
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

/**
 * 换轮次时**两个折叠都得复位**。第一层（技术明细）历轮已经钉住了，这一份盯的是新加的
 * 那一层：上一轮展开着「其余 N 条问题」，换一份报告过来不该还是展开的。
 */
function SwitchableSix() {
  const [second, setSecond] = useState(false);
  return (
    <>
      <button type="button" className="switch-six" onClick={() => setSecond((value) => !value)}>
        切换轮次
      </button>
      <ReviewReportBody text={sixProblems} reportKey={`run-25:${second ? 2 : 1}`} />
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
    {/* 成对挂：一份超出上限要在摘要里再折一层，一份恰好卡在上限上、一个按钮都不该多画。 */}
    <div className="six-problems-fixture markdown-report-body">
      <ReviewReportBody text={sixProblems} reportKey="run-23:1" />
    </div>
    <div className="five-problems-fixture markdown-report-body">
      <ReviewReportBody text={fiveProblems} reportKey="run-24:1" />
    </div>
    <div className="contradictory-uncounted-fixture markdown-report-body">
      <ReviewReportBody text={contradictoryUncounted} reportKey="run-26:1" />
    </div>
    {/* 复审第 2 轮的三份：分界标题本身就是问题、问题藏在更深一层、判定写成「不建议通过」。
        三份都必须整篇铺开——首屏写着「没有发现问题」时，任何一条真问题都不许进折叠。 */}
    <div className="problem-at-boundary-fixture markdown-report-body">
      <ReviewReportBody text={problemAtBoundary} reportKey="run-27:1" />
    </div>
    <div className="hidden-deep-problem-fixture markdown-report-body">
      <ReviewReportBody text={hiddenDeepProblem} reportKey="run-28:1" />
    </div>
    <div className="soft-denied-fixture markdown-report-body">
      <ReviewReportBody text={softDeniedVerdict} reportKey="run-29:1" />
    </div>
    {/* 复审第 3 轮的一对：判定还没作出（「测试通过，尚待人工验收」）必须铺开，
        判定明确作出了（`verified — no blockers`）照旧折叠——收紧不许把这一种也收掉。 */}
    <div className="pending-acceptance-fixture markdown-report-body">
      <ReviewReportBody text={pendingAcceptance} reportKey="run-30:1" />
    </div>
    <div className="english-verdict-fixture markdown-report-body">
      <ReviewReportBody text={englishVerdict} reportKey="run-31:1" />
    </div>
    {/* 复审第 4 轮：主句合格、反悔写在尾巴上（「但保存问题仍未解决」），同样得整篇铺开。 */}
    <div className="contradicted-tail-fixture markdown-report-body">
      <ReviewReportBody text={contradictedTail} reportKey="run-32:1" />
    </div>
    {/* 复审第 5 轮：判定被删除线划掉了，同样不许当成生效的「可以验收」。 */}
    <div className="revoked-verdict-fixture markdown-report-body">
      <ReviewReportBody text={revokedVerdict} reportKey="run-33:1" />
    </div>
    {/* 复审第 6 轮：一句在问的判定、一句只排除了某一类问题的判定，都不算把话说死。 */}
    <div className="hedged-verdict-fixture markdown-report-body">
      <ReviewReportBody text={hedgedVerdict} reportKey="run-34:1" />
    </div>
    <div className="narrowed-scope-fixture markdown-report-body">
      <ReviewReportBody text={narrowedScope} reportKey="run-35:1" />
    </div>
    {/* 复审第 7 轮：一句没说完的判定，和一条三行都渲染不出字的「问题」。 */}
    <div className="unfinished-verdict-fixture markdown-report-body">
      <ReviewReportBody text={unfinishedVerdict} reportKey="run-36:1" />
    </div>
    <div className="invisible-problem-fixture markdown-report-body">
      <ReviewReportBody text={invisibleProblem} reportKey="run-37:1" />
    </div>
    {/* 复审第 8 轮：一句被斜体包着、其实没说完的判定，和三行都写成本地磁盘图片的「问题」
        ——后者在页面上是标题底下一整片空白，`alt` 一个字都不出。 */}
    <div className="decorated-verdict-fixture markdown-report-body">
      <ReviewReportBody text={decoratedVerdict} reportKey="run-38:1" />
    </div>
    <div className="image-alt-problem-fixture markdown-report-body">
      <ReviewReportBody text={imageAltProblem} reportKey="run-39:1" />
    </div>
    <div className="six-switch-fixture markdown-report-body">
      <SwitchableSix />
    </div>
    <div className="switch-fixture markdown-report-body">
      <SwitchableReport />
    </div>
    <div className="identical-fixture markdown-report-body">
      <SwitchableReport identical />
    </div>
  </StrictMode>,
);
