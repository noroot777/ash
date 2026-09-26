// 四栏写成 `###` 小标题的那一种写法——签名判据的第二种形态。加粗标签那一版在
// `test-review-report-sections.mjs`，降级折到哪在 `test-review-report-fallback.mjs`，
// 「哪个 `##` 是分界」在 `test-review-report-boundary.mjs`。
//
// 拆出来是因为那份文件写到 690 行（上限 700）。这一档自成一件事：同样四个栏目、同样
// 必须过「齐全按序不重样」和「问题证明得了在摘要里」两道闸，只是**载体从段落换成了标题**，
// 于是每道闸的判据都要跟着降一级写——问题小标题得是 `####`，标题文字得整段全文相等。
//
// 三条别再走回头路的判据：
// ① 这种写法得认。只认加粗版时，全库 4 份这样写的真实报告（含本任务上一轮的审查报告）
//    整份技术明细重新铺满首屏，正好是这次改动要消灭的东西。
// ② 「问题小标题至少多深」跟着栏目写法走一级。写死 `>= 3` 时，栏目自己那一级的 `###`
//    就能冒充问题条目，「齐全按序」和「问题在摘要里」两道闸一起被绕开。
// ③ 栏目标题要**整段全文相等**（容一个结尾冒号）。放宽成前缀，加粗版被抓过三次的那批
//    续写措辞就会原样搬过来。
import assert from "node:assert/strict";
import { splitReviewReport } from "../src/components/reviewReportSections.ts";
import { headingContract } from "./fixtures/review-report-contract.mjs";

// 四栏的**另一种真实写法**：写成 `###` 小标题，每条问题写成 `####`。认不出它的后果不是
// 少折一点，是整份技术明细重新铺满首屏——全库 1036 份里 4 份长这样，其中一份就是本任务
// 上一轮的审查报告。
{
  const text = `## 结论\n\n${headingContract}\n\n## 被审范围\n\n- 基线 \`d7ee0b07\`\n\n## 清场\n\n已停掉 5175。\n`;
  const { summary, detail, kind } = splitReviewReport(text);
  assert.equal(kind, "contract", "小标题写法跟加粗写法一样确定，一样该认");
  assert.match(summary, /### 能不能验收/, "四栏留在首屏");
  assert.match(summary, /烧录出来的成片/, "问题本身留在首屏");
  assert.doesNotMatch(summary, /被审范围|d7ee0b07|清场/, "技术记录收进明细");
  assert.match(detail, /^## 被审范围/);
}

// 这一档同样要过 ④⑥ 两道闸，判据跟着写法走一级：栏目是 `###`，问题就得是 `####`。
{
  // 少一栏
  const three = headingContract.split("\n### 不拦验收、但你该知道的")[0];
  assert.equal(
    splitReviewReport(`## 结论\n\n${three}\n\n## 明细\n\n略\n`).detail,
    "",
    "小标题写法缺一栏同样不算契约",
  );
}
{
  // 倒序
  const reversed = [
    "### 不拦验收、但你该知道的", "", "没有。", "",
    "### 必须修的问题", "", "#### 1. 导出内容仍是旧版本", "", "你会遇到：……", "",
    "### 现在什么能用了", "", "略。", "",
    "### 能不能验收", "", "不能。",
  ].join("\n");
  const { summary, detail } = splitReviewReport(`## 结论\n\n${reversed}\n\n## 明细\n\n略\n`);
  assert.equal(detail, "", "四栏倒着写是抄件，不是按契约写的摘要");
  assert.match(summary, /导出内容仍是旧版本/, "问题必须留在首屏");
}
{
  // 问题写成 `###`：那是栏目自己那一级，冒充不了问题小标题（否则 ④⑥ 一起被绕开）
  const shallow = [
    "### 能不能验收", "", "不能 —— 有 1 条必须先修。", "",
    "### 现在什么能用了", "", "略。", "",
    "### 必须修的问题", "", "见下方。", "",
    "### 不拦验收、但你该知道的", "", "没有。",
  ].join("\n");
  const { summary, detail } = splitReviewReport(
    `## 结论\n\n${shallow}\n\n## 导出内容仍是旧版本\n\n你会遇到：……\n`,
  );
  assert.equal(detail, "", "拿不出 `####` 问题小标题就不能拆");
  assert.match(summary, /导出内容仍是旧版本/, "问题必须留在首屏");
}
{
  // 同上，但两栏之间**真有**一个 `###`——它是栏目自己那一级的闲话，不是问题条目。
  // 「问题小标题至少多深」写死成 `>= 3` 时，这一行就能冒充问题证明，把真正的问题折走。
  const strayHeading = [
    "### 能不能验收", "", "不能 —— 有 1 条必须先修。", "",
    "### 现在什么能用了", "", "略。", "",
    "### 必须修的问题", "", "见下方。", "",
    "### 补充说明", "", "这一段不是问题条目。", "",
    "### 不拦验收、但你该知道的", "", "没有。",
  ].join("\n");
  const { summary, detail } = splitReviewReport(
    `## 结论\n\n${strayHeading}\n\n## 导出内容仍是旧版本\n\n你会遇到：……\n`,
  );
  assert.equal(detail, "", "栏目同级的标题不是问题小标题，证明不了问题在摘要里");
  assert.match(summary, /导出内容仍是旧版本/, "问题必须留在首屏");
}
{
  // 没问题那一支照拆
  const none = [
    "### 能不能验收", "", "可以。", "",
    "### 现在什么能用了", "", "略。", "",
    "### 必须修的问题", "", "没有发现问题", "",
    "### 不拦验收、但你该知道的", "", "没有。",
  ].join("\n");
  assert.match(
    splitReviewReport(`## 结论\n\n${none}\n\n## 明细\n\n略\n`).detail,
    /^## 明细/,
    "「没有发现问题」那一支同样该拆",
  );
}
{
  // 第 4 轮的原样复现：栏目写成 `###`，问题栏塞的是一句**含着那六个字的否定句**。
  // 子串判据下它返回 `contract`，真正的问题被折进一个写着「技术明细」的开关里。
  const negated = [
    "### 能不能验收", "", "不能 —— 有 1 条必须先修。", "",
    "### 现在什么能用了", "", "基础流程可用。", "",
    "### 必须修的问题", "", "详情见下方；这里不是说没有发现问题", "",
    "### 不拦验收、但你该知道的", "", "没有。",
  ].join("\n");
  const { summary, detail, kind } = splitReviewReport(
    `## 结论\n\n${negated}\n\n## 保存后内容会全部消失\n\n你会遇到：点保存以后整篇内容清空。\n`,
  );
  assert.equal(kind, "whole", "否定句不是「这一栏只写了没有发现问题」");
  assert.equal(detail, "");
  assert.match(summary, /保存后内容会全部消失/, "问题必须留在首屏");
}
// 标题得是**整段全文相等**，不是开头像。这跟加粗那一版被抓过三次的放宽是同一条教训。
for (const bad of ["### 能不能验收不了", "### 能不能验收（详见下文）", "### 先说能不能验收"]) {
  const broke = headingContract.replace("### 能不能验收", bad);
  assert.equal(
    splitReviewReport(`## 结论\n\n${broke}\n\n## 明细\n\n略\n`).detail,
    "",
    `${bad} 不是固定栏目`,
  );
}
// 结尾一个冒号是真实写法，认。
for (const colon of ["：", ":"]) {
  const withColon = headingContract.replace("### 能不能验收", `### 能不能验收${colon}`);
  assert.match(
    splitReviewReport(`## 结论\n\n${withColon}\n\n## 明细\n\n略\n`).detail,
    /^## 明细/,
    `小标题结尾带「${colon}」仍属于契约`,
  );
}

console.log("review report heading columns ok");
