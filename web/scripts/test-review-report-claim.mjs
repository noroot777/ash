// 折叠按钮**能说什么**——这一档判据的全部。切点在哪是另一件事，在
// `test-review-report-boundary.mjs` 和 `test-review-report-fallback.mjs`。
//
// 这份文件替下来的是十轮复审、六百多行的一套判据。那套判据干的事是「从报告正文里猜作者
// 到底有没有说可以验收」，好决定按钮敢不敢宣称「里面只有验证过程、证据、清场记录」。
// 十轮下来，每一轮审查者都造得出新反例：
//
//   no fixed issues / no new issues / 可以验收？ / 可以验收… / ~~可以验收~~ / ❌ 可以验收 /
//   [ ] 可以验收 / 测试通过，尚待人工验收 / 不建议通过 / 可以验收，但保存问题仍未解决 /
//   可以验收： / verified — / pass; / _可以验收：_ / `pass;` / “可以验收，” /
//   你会遇到：[](#x) / 三行各写一张本地图片 ……
//
// 每一条都是同一个形状：判据比它要证明的事松一档。**反例空间无限、词表可枚举**，这个
// 形状收敛不了。所以 2026-09-28 换了问法：这一轮到底通没通过，`conclusion` 那个权威字段
// 里存着，界面上那个红绿标签渲染的就是它——不猜了。
//
// 于是这份文件的主用例就是：**把上面那些反例原样喂进去，断言按钮一个字都不宣称**。它们
// 作为语料仍然值钱——每一份都是一份真实存在过的、正文会骗人的报告；只是现在不需要读懂
// 它们，只需要知道这一轮没通过。
//
// 三条别再走回头路的判据：
// ① 按钮说什么**只看 `conclusion`**。再往正文里加一条「像是通过就放行」的判据，等于把十
//    轮的反例空间重新打开。
// ② 拿不到结论（老数据、还没判、或者打开的是一份孤立的 report.md）一律按「不宣称」办。
// ③ 结论管的是**按钮**，不是**切点**。切点由报告自己的结构决定——同一份报告换个结论，
//    铺开的那一半必须一字不差。
import assert from "node:assert/strict";
import { splitReviewReport } from "../src/components/reviewReportSections.ts";
import {
  conforming,
  contradictoryNone,
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
  legacyConclusion,
  headingColumns,
  englishConclusion,
  negatedNoProblem,
  nonProblemHeading,
  findingsReport,
  severityFirst,
  metadataFirst,
  quoted,
  proseCopy,
  reordered,
  wrongHeading,
  problemAsHeading,
  countsShort,
  spilled,
} from "./fixtures/review-report-texts.ts";

// 十轮复审攒下来的**正文会骗人**的报告，一份不落。它们当年各自绕过了一道判据；现在
// 不读它们的正文，只问权威结论——没通过就一个字都不宣称。
const DECEPTIVE = {
  "首屏说没问题、条数却对不上": contradictoryNone,
  "说不能验收、又说没有发现问题": contradictoryUncounted,
  "那条问题自己就是第二个 `##`": problemAtBoundary,
  "问题藏在更深一层": hiddenDeepProblem,
  "判定写成「不建议通过」": softDeniedVerdict,
  "判定还没作出": pendingAcceptance,
  "反悔写在尾巴上": contradictedTail,
  "判定被划掉": revokedVerdict,
  "判定是在问": hedgedVerdict,
  "只排除了一类问题": narrowedScope,
  "判定没说完": unfinishedVerdict,
  "三行渲染不出字": invisibleProblem,
  "没说完的判定套了层斜体": decoratedVerdict,
  "三行是页面渲染不出的图": imageAltProblem,
  "正文里躺着一句 verified": englishVerdict,
};

// ① 权威结论说没通过 —— 正文写什么都不算数，按钮一个字都不宣称。
for (const [what, text] of Object.entries(DECEPTIVE)) {
  const { kind } = splitReviewReport(text, "verify_failed");
  assert.notEqual(kind, "contract", `${what}：这一轮没通过，按钮不许替折叠里的东西背书`);
}

// ② 拿不到结论也一样。老数据、还没判完、或者用户点开的是正文里那个 report.md 链接——
//    三种情况手上都没有权威答案，一律按「不宣称」办。
for (const [what, text] of Object.entries(DECEPTIVE)) {
  const { kind } = splitReviewReport(text, null);
  assert.notEqual(kind, "contract", `${what}：没有权威结论就别替报告说话`);
}
{
  const { kind } = splitReviewReport(conforming, null);
  assert.equal(kind, "lead", "一份格式完全正确的报告，拿不到结论时照样不宣称");
}

// ③ 反过来也得成立：权威结论说通过、报告又照格式写了，那句承诺就该给出去——否则整份
//    技术明细重新铺满首屏，正是这个功能要消灭的东西。
for (const [what, text] of [
  ["加粗标签四栏", conforming],
  ["四栏写成 `###` 小标题", headingColumns],
]) {
  const { kind, detail } = splitReviewReport(text, "verified");
  assert.equal(kind, "contract", `${what}：通过了的报告，折叠里只剩技术记录`);
  assert.match(detail, /^## /, `${what}：折的起点是第二个二级标题`);
}

// ④ 结论管按钮、不管切点：同一份报告换个结论，铺开的那一半必须一字不差。十轮攒下来的
//    全部真实形态都在这里过一遍——三档（切成两半 / 只留引子 / 整篇铺开）各自都得纹丝不动。
for (const [what, text] of Object.entries({
  ...DECEPTIVE,
  "格式正确的报告": conforming,
  "旧格式的结论节": legacyConclusion,
  "英文结论节": englishConclusion,
  "Findings 开场": findingsReport,
  "标了严重度的开场": severityFirst,
  "元数据开场": metadataFirst,
  "否定句冒充没问题": negatedNoProblem,
  "说明性小标题冒充问题": nonProblemHeading,
  "四栏写成小标题": headingColumns,
  "引用里抄着上一轮的四栏": quoted,
  "说明段里抄着四栏": proseCopy,
  "四栏整个倒着写": reordered,
  "首节写成「前言」": wrongHeading,
  "问题误用二级标题": problemAsHeading,
  "说了 2 条只写了 1 条": countsShort,
  "问题多到摘要里只列标题": spilled,
})) {
  const passed = splitReviewReport(text, "verified");
  const failed = splitReviewReport(text, "verify_failed");
  assert.equal(passed.summary, failed.summary, `${what}：切点不该跟着结论变`);
  assert.equal(passed.detail, failed.detail, `${what}：切点不该跟着结论变`);
}

console.log("review report claim ok");
