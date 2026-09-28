// 审查报告摘要/明细折叠的 DOM fixture：把每一档并排挂出来。
//
// 并排是必须的：这个改动真正的风险不是「折叠不灵」，而是**按钮替折叠里的东西撒谎**——
// 首屏写着「没问题」、真正的问题折在一个宣称「里面只有验证过程、证据、清场记录」的开关
// 底下。所以这一份的主线是同一份报告配不同的权威结论：`verified` 那份敢宣称，其余一律
// 只写「展开完整报告」。
//
// 报告正文在 `review-report-texts.ts`（十轮复审攒下来的真实形态，只增不改），这一份只
// 负责挂载。每一档的判据由纯函数测试穷举（`test-review-report-*.mjs`），这里只挂**屏幕上
// 看得出差别**的那几份。
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReviewReportBody } from "../../src/components/MarkdownBody.tsx";
import {
  conforming,
  conformingRound2,
  legacy,
  fenced,
  commented,
  proseCopy,
  legacyConclusion,
  headingColumns,
  metadataFirst,
  justOver,
  contradictoryNone,
} from "./review-report-texts.ts";
import "../../src/styles/global.css";

// 在**同一个位置**换报告，模拟侧栏抽屉切换轮次。展开状态如果是独立 state，换一轮就会串
// 过去——下一份报告一打开就是满屏命令输出，恰好是这个改动要消灭的东西。
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
        conclusion="verified"
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* 第一档：这一轮**权威结论是通过**，报告又照格式写了四栏。只有这一种配得上那句
        「展开技术明细（验证过程、证据、清场记录）」。 */}
    <div className="conforming-fixture markdown-report-body">
      <ReviewReportBody text={conforming} reportKey="run-1:4" conclusion="verified" />
    </div>
    {/* 同一份正文、换一个权威结论。这两份并排就是整套判据：按钮说什么只看 `conclusion`,
        不看报告写了什么。正文里那句「能不能验收」骗得过判据，骗不过这个字段。 */}
    <div className="failed-fixture markdown-report-body">
      <ReviewReportBody text={conforming} reportKey="run-1:5" conclusion="verify_failed" />
    </div>
    {/* 拿不到结论（老数据、还没判完）同样按「不宣称」办。 */}
    <div className="unknown-fixture markdown-report-body">
      <ReviewReportBody text={conforming} reportKey="run-1:6" conclusion={null} />
    </div>
    {/* Windows 上生成的同一份报告：换行是 CRLF，屏幕上该长得一模一样。 */}
    <div className="crlf-fixture markdown-report-body">
      <ReviewReportBody text={conforming.replace(/\n/g, "\r\n")} reportKey="run-3:1" conclusion="verified" />
    </div>
    {/* 切点落在哪：代码围栏里的 `##`、HTML 注释里的 `##` 都不是分界。 */}
    <div className="fence-fixture markdown-report-body">
      <ReviewReportBody text={fenced} reportKey="run-4:6" conclusion="verified" />
    </div>
    <div className="comment-fixture markdown-report-body">
      <ReviewReportBody text={commented} reportKey="run-5:7" conclusion="verified" />
    </div>
    {/* 四栏写成 `###` 小标题：全库 4 份真实报告长这样，同样算照格式写的。 */}
    <div className="heading-columns-fixture markdown-report-body">
      <ReviewReportBody text={headingColumns} reportKey="run-12:3" conclusion="verified" />
    </div>
    {/* 第二档：切得动，但按钮什么都不宣称。两份的来由不同——一份是这一轮没通过，一份是
        通过了却没照格式写（判定写在 `## 结论` 那一节里的旧形态，全库 146 份）。 */}
    <div className="legacy-fixture markdown-report-body">
      <ReviewReportBody text={legacy} reportKey="run-2:1" conclusion="verify_failed" />
    </div>
    <div className="legacy-conclusion-fixture markdown-report-body">
      <ReviewReportBody text={legacyConclusion} reportKey="run-11:1" conclusion="verified" />
    </div>
    {/* 正文自相矛盾的那一类（首屏「没有发现问题」、条数却写着 2）：现在不读它，只问权威
        结论。没通过 = 按钮一个字都不宣称。 */}
    <div className="contradictory-fixture markdown-report-body">
      <ReviewReportBody text={contradictoryNone} reportKey="run-21:1" conclusion="verify_failed" />
    </div>
    {/* 第三档：切不动。说明段里抄了四行栏目名、却凑不齐签名 = 新格式写坏了，问题本来就
        该在结论节里，从第二个 `##` 起切会把问题一起切走——整篇铺开。 */}
    <div className="prose-copy-fixture markdown-report-body">
      <ReviewReportBody text={proseCopy} reportKey="run-7:9" conclusion="verified" />
    </div>
    {/* 同一档的另一半：元数据开场，连引子都凑不出来。不猜切点，按渲染高度夹住。 */}
    <div className="metadata-first-fixture markdown-report-body">
      <ReviewReportBody text={metadataFirst} reportKey="run-19:1" conclusion="verify_failed" />
    </div>
    {/* 只超出上限两百来 px 的报告：夹住省不下什么，一个按钮都不该画。判据是渲染高度，
        所以这一份的宽度写死。 */}
    <div className="just-over-fixture markdown-report-body" style={{ width: 720 }}>
      <ReviewReportBody text={justOver} reportKey="run-20:1" conclusion="verify_failed" />
    </div>
    <div className="switch-fixture markdown-report-body">
      <SwitchableReport />
    </div>
    <div className="identical-fixture markdown-report-body">
      <SwitchableReport identical />
    </div>
  </StrictMode>,
);
