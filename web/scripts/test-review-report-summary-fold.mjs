// 摘要内部那第二层折叠：报告照格式写了、问题却超过 5 条时，前 5 条铺开、其余收进「展开
// 其余 N 条问题」，第四栏跨过这一层继续留在首屏。（用户 2026-09-27 裁定，见 `5a34b180`：
// 降档解决不了这件事——降档换的是技术明细按钮说什么，铺开的那一段一个字都不会少。）
//
// 这一层**不看权威结论**，跟外层那个按钮是两回事：它的按钮照实写「展开其余 N 条问题」，
// 名字就是内容，撒不了谎。而且问题多到 6 条的报告几乎必然是 `verify_failed`——跟着
// `conclusion` 走等于把这一层关掉。所以下面统一按「这一轮没通过」调用，那才是它的主场。
//
// 这一份钉两件事：
//
// ① **切点对不对**——中段从第 6 条的小标题起、到第四栏为止；恰好 5 条和 5 条以下不分层。
// ② **一个字都没丢**（`conserves`）。切成四段之后最容易出的事不是「折叠不灵」，是某一段
//    在重新拼装时掉了或者重了，而屏幕上看着一切正常——中段默认收着，丢在里面根本没人
//    发现。所以守恒对**每一种已知形态**都跑一遍，包括压根不分层的那些。
//
// 守恒怎么验，踩过一次：先想的是「去掉空白差异后逐字符相等」，那比它要证明的事松一档。
// Markdown 的空行、缩进、行尾空格都带语义（分列表项、划代码块、断软换行），把空白抹平
// 之后，「内容没丢但结构已经坏了」的实现照样通过。所以改成**前向扫描**：每一段都必须是
// 原文里的一段连续字节（`indexOf` 只认精确匹配，段内空白因此是字节级保留的），段与段
// 之间的空隙必须全是空白，游标单调右移顺带把重复和乱序一起钉死。
//
// 边界上为什么容忍空白：切点取的是解析树里**顶层节点的起始行**，按构造落不进围栏、列表
// 项或表格内部，被 `cut()` 的 `trimEnd()` 吃掉的只可能是块与块之间的空行。段**内**的
// 损坏由上面的字节级相等挡住，两层分工不同。
//
//   node --experimental-strip-types scripts/test-review-report-summary-fold.mjs
import assert from "node:assert/strict";
import { splitReviewReport } from "../src/components/reviewReportSections.ts";
import * as corpus from "./fixtures/review-report-texts.ts";

const split = (text, conclusion = "verify_failed") => splitReviewReport(text, conclusion);

/**
 * 四段合起来还是原文：首尾相接、不重、不漏、不乱序。
 *
 * 空段跳过——`more`/`aside` 在不分层的形态下本来就是空串，`detail` 在 `whole` 档也是。
 */
function conserves(text, what, conclusion = "verify_failed") {
  const { summary, more, aside, detail } = splitReviewReport(text, conclusion);
  let cursor = 0;
  for (const [name, section] of [["summary", summary], ["more", more], ["aside", aside], ["detail", detail]]) {
    if (!section) continue;
    const at = text.indexOf(section, cursor);
    assert.ok(at >= 0, `${what}：${name} 不是原文里的一段连续字节（改了内容或顺序反了）`);
    assert.match(text.slice(cursor, at), /^\s*$/, `${what}：${name} 之前漏掉了一段正文`);
    cursor = at + section.length;
  }
  assert.match(text.slice(cursor), /^\s*$/, `${what}：末段之后还剩着正文没收`);
}

const problem = (n) => `### ${n}. 第 ${n} 处会出错
你会遇到：做第 ${n} 步操作时页面报错。
为什么：第 ${n} 处的判断写反了。
建议怎么修：把第 ${n} 处的判断改回来。`;

/** 一份四栏齐全、每条三行俱全、条数也对得上的契约报告。 */
const report = (count) => `# 审查报告

## 结论

**能不能验收**：不能 —— 有 ${count} 条必须先修。

**现在什么能用了**：页面打得开，保存也落盘了。

**必须修的问题**：

${Array.from({ length: count }, (_, at) => problem(at + 1)).join("\n\n")}

**不拦验收、但你该知道的**：还有两处文案不统一。

## 技术明细

基线 hash：abc123；构建与测试均退出 0。
`;

{
  const text = report(6);
  const { summary, more, rest, aside, detail, kind } = split(text);
  assert.equal(kind, "lead", "这一轮没通过，外层按钮照旧什么都不宣称");
  assert.equal(rest, 1, "按钮上的 N 是「摘要里没铺开的条数」");
  assert.match(summary, /### 5\. 第 5 处会出错/, "前五条留在首屏");
  assert.doesNotMatch(summary, /### 6\./, "第六条不该还在首屏");
  assert.match(more, /^### 6\. 第 6 处会出错/, "中段从第六条的小标题起");
  assert.match(more, /建议怎么修：把第 6 处的判断改回来。$/, "中段到第四栏之前为止");
  assert.doesNotMatch(more, /不拦验收/, "第四栏不该被卷进中段");
  assert.match(aside, /^\*\*不拦验收、但你该知道的\*\*/, "第四栏跨过中段，单独留在首屏");
  assert.match(detail, /^## 技术明细/, "技术明细那一刀没变");
  conserves(text, "六条问题");

  // 中段**不跟着权威结论走**：换成「通过了」，外层按钮升到契约档，四段一个字不动。
  // 反过来写死成「只有 contract 档才分层」的话，这一层就只对 `verified` 生效——而 6 条
  // 必须先修的报告几乎必然是 `verify_failed`，等于原地关掉它。
  const passed = splitReviewReport(text, "verified");
  assert.equal(passed.kind, "contract", "同一份报告通过了就该升档");
  for (const part of ["summary", "more", "aside", "detail"]) {
    assert.equal(passed[part], split(text)[part], `换个结论不许动 ${part}`);
  }
  assert.equal(passed.rest, rest, "换个结论不许动按钮上的 N");
}

{
  // N 是「其余几条」而不是「一共几条」：12 条时铺 5 条、折 7 条。
  const { rest, more, summary } = split(report(12));
  assert.equal(rest, 7);
  assert.match(summary, /### 5\./);
  assert.doesNotMatch(summary, /### 6\./);
  assert.match(more, /^### 6\./);
  assert.match(more, /### 12\. 第 12 处会出错/, "最后一条也在中段里");
  conserves(report(12), "十二条问题");
}

{
  // 一条问题自己写细了（底下再分 `#### 复现步骤`）：那是**这条问题的一部分**，不是
  // 另一条问题。收「比栏目深就算」的话，5 条问题里只要有一条写细了就凑够 6 个标题，
  // 中段那一刀于是落进某条问题的中间——折出来半截问题，比不折更难读。
  const detailed = report(5).replace(
    "建议怎么修：把第 3 处的判断改回来。",
    "建议怎么修：把第 3 处的判断改回来。\n\n#### 复现步骤\n\n1. 打开项目；2. 点第 3 步。",
  );
  const { more, rest, aside, summary } = split(detailed);
  assert.equal(rest, 0, "写细的子标题不是一条问题，撑不大条数");
  assert.equal(more, "", "5 条仍然不分层");
  assert.equal(aside, "");
  assert.match(summary, /#### 复现步骤/, "子标题跟着它那条问题留在首屏");
  conserves(detailed, "某条问题写细了");

  // 同一份加到 6 条：这时才该分层，而且切点落在第 6 条的小标题上，不是那个子标题上。
  const six = detailed.replace("有 5 条必须先修", "有 6 条必须先修").replace(
    "\n\n**不拦验收、但你该知道的**",
    `\n\n${problem(6)}\n\n**不拦验收、但你该知道的**`,
  );
  const sixth = split(six);
  assert.equal(sixth.rest, 1, "第 6 条才是第 6 条");
  assert.match(sixth.more, /^### 6\. 第 6 处会出错/, "切点落在第 6 条的小标题上");
  assert.match(sixth.summary, /#### 复现步骤/, "子标题仍跟着第 3 条留在首屏");
  conserves(six, "写细之后又加到六条");
}

// 恰好 5 条、以及更少：不分层，一个按钮就够。多画一个「展开其余 0 条」是纯噪音。
for (const count of [1, 2, 4, 5]) {
  const { summary, more, rest, aside, kind } = split(report(count));
  assert.equal(kind, "lead", `${count} 条：外层档位由权威结论定，跟分不分层无关`);
  assert.equal(more, "", `${count} 条：不分中段`);
  assert.equal(rest, 0, `${count} 条：没有「其余 N 条」`);
  assert.equal(aside, "", `${count} 条：第四栏留在 summary 里`);
  assert.match(summary, /\*\*不拦验收、但你该知道的\*\*/, `${count} 条：第四栏在首屏`);
  conserves(report(count), `${count} 条问题`);
}

{
  // 四栏写成 `###`、问题写成 `####` 的那种真实形态（`MiBg8G40scWo` 等 4 份）也得分层：
  // 判据走的是另一条分支（`headingColumns`），中段的切点得跟着那一条一起算出来。
  const headings = (count) => `# 审查报告

## 结论

### 能不能验收

不能 —— 有 ${count} 条必须先修。

### 现在什么能用了

页面打得开。

### 必须修的问题

${Array.from({ length: count }, (_, at) => `#### ${at + 1}. 第 ${at + 1} 处会出错
你会遇到：做第 ${at + 1} 步操作时页面报错。
为什么：第 ${at + 1} 处的判断写反了。
建议怎么修：把第 ${at + 1} 处的判断改回来。`).join("\n\n")}

### 不拦验收、但你该知道的

还有两处文案不统一。

## 技术明细

基线 hash：abc123。
`;
  const { summary, more, rest, aside, kind } = split(headings(7));
  assert.equal(kind, "lead", "`###` 栏目版的外层档位同样由权威结论定");
  assert.equal(rest, 2, "`###` 栏目版也要分中段");
  assert.doesNotMatch(summary, /#### 6\./, "第六条不在首屏");
  assert.match(more, /^#### 6\./, "中段从第六条起");
  assert.match(aside, /^### 不拦验收、但你该知道的/, "第四栏是那个 `###` 小标题本身");
  conserves(headings(7), "`###` 栏目版七条");

  const five = split(headings(5));
  assert.equal(five.more, "", "`###` 栏目版恰好五条也不分层");
  assert.equal(five.kind, "lead");
  conserves(headings(5), "`###` 栏目版五条");
}

{
  // 第 N 条之后的补充散文：跟着最后一条一起进中段。不为它再开第三个控件——首屏多一个
  // 用户不知道该不该点的按钮，比让它跟着问题一起折起来更糟。
  const trailing = report(6).replace(
    "\n\n**不拦验收、但你该知道的**",
    "\n\n以上六条按用户会踩到的严重程度排过序。\n\n**不拦验收、但你该知道的**",
  );
  const { more, aside, rest } = split(trailing);
  assert.equal(rest, 1, "尾随散文不算一条问题，撑不大按钮上的 N");
  assert.match(more, /以上六条按用户会踩到的严重程度排过序。$/, "尾随散文归中段");
  assert.match(aside, /^\*\*不拦验收、但你该知道的\*\*/);
  conserves(trailing, "第六条之后还有一段补充散文");
}

{
  // 报告自己分流那条路子（摘要里 5 条 + 一行「其余 N 条：…」，完整三行写进明细）：
  // 摘要里本来就只有 5 条，**没有第 6 条可折**，所以不分中段。分不分层数的是摘要里真实
  // 存在的条目，不是报告自己报的那个数——照着报的数折，会切到一个不存在的行上。
  const spill = report(5).replace(
    "有 5 条必须先修",
    "有 8 条必须先修",
  ).replace(
    "\n\n**不拦验收、但你该知道的**",
    "\n\n其余 3 条：导出乱码、筛选丢状态、返回丢草稿，完整写在下面的技术明细里。\n\n**不拦验收、但你该知道的**",
  );
  const { more, rest, aside, kind } = split(spill);
  assert.equal(kind, "lead", "这一轮没通过，外层按钮什么都不宣称");
  assert.equal(more, "", "降级档不分中段");
  assert.equal(rest, 0);
  assert.equal(aside, "");
  conserves(spill, "五条 + 分流声明");
}

{
  // 整篇铺开那一档：四段里只有 summary 非空，守恒退化成「summary 就是原文」。
  const { summary, more, rest, aside, detail, kind } = split(corpus.metadataFirst);
  assert.equal(kind, "whole");
  assert.equal(summary, corpus.metadataFirst);
  assert.equal(more, "");
  assert.equal(rest, 0);
  assert.equal(aside, "");
  assert.equal(detail, "");
}

// 守恒对**每一种已知形态**都成立，不只是分层的那些。这份语料是历轮抓到的真实/构造形态
// 全集（`fixtures/review-report-texts.ts`，只增不改），新形态加进去就自动跑到。
// 三种权威结论各跑一遍：结论只该换按钮文案，换不动任何一刀。
for (const [name, text] of Object.entries(corpus)) {
  if (typeof text !== "string") continue;
  for (const conclusion of ["verify_failed", "verified", null]) {
    conserves(text, `语料 ${name}（${conclusion ?? "无结论"}）`, conclusion);
    conserves(text.replace(/\n/g, "\r\n"), `语料 ${name}（CRLF/${conclusion ?? "无结论"}）`, conclusion);
  }
}

console.log("review report summary fold ok");
