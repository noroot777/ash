// 一份报告**算不算按契约写的**——签名判据。钉住它是因为契约横跨前后端：
// `server/src/review-report-format.ts` 让审查者写出四段固定摘要，这里认那四段拆。任何
// 一边漂了，用户要么看见整篇合规证明，要么更糟——发现被藏进一个宣称「里面只有验证过程、
// 证据、清场记录」的折叠里。所以「认不出契约时不许走第一档」是重点用例。
//
// 折叠有两档，签名决定走哪一档（两档的定义见 `reviewReportSections.ts`）：认出契约就拆
// 在第二个 `##`、按钮写「展开技术明细」；认不出就降级，按钮只写「展开完整报告」，什么都
// 不宣称。降级一档的代价是多点一下按钮，误判成契约的代价是让按钮替报告撒谎——所以拿不准
// 一律往下降。
//
// 降级那一档**折到哪**在 `test-review-report-fallback.mjs`；「哪个 `##` 是分界」在
// `test-review-report-boundary.mjs`。
//
// 六条**别再走回头路**的判据，各自有用例钉在下面：
// ① 别拿标题**代替**四栏。「标题里有没有『结论』」那一版放行过两份真实报告，把【高】/
//    高危发现整批折叠进了写着「验证过程、证据、清场记录」的按钮下面。注意跟 ⑤ 区分：
//    首节必须是 `## 结论` 是**又一道闸**，不是把判据换回标题。
// ② 别把签名放宽。这个判据已经被放宽过三次，每次都被审查抓回来，后果一模一样：
//    「命中任意两段」让半套摘要过关；「只锚定行首」让 `**能不能验收不了**` 过关；
//    「只要求闭合 `**`」让 `**能不能验收**不了解的人先看这里` 过关。首屏都写着有问题，
//    问题本身都在折叠里，按钮还在替它背书。拿不准就降到第二档。
// ③ 「哪些行有资格当契约标记」别改回黑名单。「排除代码块和 HTML 块、剩下的都算」漏过
//    块引用——引用段落的后续行可以省掉 `>`，源码看着顶格，解析树里整段在 blockquote 里。
//    白名单（顶层段落 + 顶层列表直属项）漏掉一种写法只是不拆，黑名单漏掉一种是藏发现。
// ④ 签名要认「四个独立栏目、齐全按序不重样」，不是「这四个词都出现过」。只收节点**起始
//    行**——收整段时，一个说明段里顺手抄四行旧结论就够签名了；只验集合不验顺序时，四栏
//    完全倒着写也算数。两种都是抄件，不是按契约写的摘要。
// ⑤ 首节标题得是 `## 结论`（prompt 原话：「就用这四个字起头」）。开头写「## 前言」、
//    里面整段抄上一轮四项结论的报告，四栏独立成段、顺序还对，光验四栏就放行。
// ⑥ 光有四个标签不算数，还得**证明问题本身在摘要里**：要么每条问题一个小标题，要么只写
//    「没有发现问题」。否则「必须修的问题：见下方」+ 问题误用 `##` 就能把它折进明细。
import assert from "node:assert/strict";
import { splitReviewReport } from "../src/components/reviewReportSections.ts";
import { contract, conforming } from "./fixtures/review-report-contract.mjs";

{
  const { summary, detail } = splitReviewReport(conforming);
  assert.match(summary, /## 结论/);
  assert.match(summary, /不能 —— 有 1 条必须先修/);
  assert.match(summary, /烧录出来的成片/, "问题本身必须留在摘要里，那才是用户要看的");
  // 摘要段止于第二个 `##`：明细一行都不许漏进来。
  assert.doesNotMatch(summary, /被审范围|基线|清场|d7ee0b07/);
  // 明细从第二个 `##` 起，后面的小节全都在——折叠不是丢弃。
  assert.match(detail, /^## 被审范围与基线/);
  assert.match(detail, /## 清场/);
  assert.match(detail, /已停掉 5175。/);
  assert.equal(`${summary}\n\n${detail}`.replace(/\s+/g, ""), conforming.replace(/\s+/g, ""));
}

// 半套摘要（第 2 轮审查报告里的反例）：前两栏写对了，第三栏却写成了 `##` 标题。
// 放宽成「任意两段」时这份会被拆，而拆点正好是「必须修的问题」——首屏写着「有 1 条
// 必须先修」，那一条却在折叠里，正是这次改动要消灭的形态。
{
  const half = [
    "# 第 1 轮审查报告",
    "",
    "## 结论",
    "",
    "**能不能验收**：不能 —— 有 1 条必须先修",
    "",
    "**现在什么能用了**：基础流程已经可用。",
    "",
    "## 必须修的问题",
    "",
    "### 导出内容仍是旧版本",
  ].join("\n");
  const { summary, detail } = splitReviewReport(half);
  assert.equal(detail, "", "四段缺一段就不是契约，不许拆");
  assert.match(summary, /导出内容仍是旧版本/, "问题必须留在首屏——半套摘要宁可整篇铺开");
}

// 首节标题本身也是契约的一部分：prompt 要求「报告开头必须先写一节 `## 结论`（就用这四个
// 字起头）」。第 10 轮的反例是一份开头写「## 前言」、里面整段抄着上一轮四项结论的报告——
// 四栏各自独立成段、顺序还对，光验四栏就照样放行。
//
// 这跟 ① 不冲突：标题是**又一道**必须过的闸，不是四栏的替代品。两道都过才算数。
{
  const { detail } = splitReviewReport(`# 报告\n\n## 结论\n\n${contract}\n\n## 明细\n\n略\n`);
  assert.match(detail, /^## 明细/, "`## 结论` + 完整四栏才是契约");
}
for (const head of ["## 结论：不能验收", "## 结论（第 3 轮）", "## 给人看的结论", "## 摘要", "## 前言"]) {
  const { summary, detail } = splitReviewReport(
    `# 报告\n\n${head}\n\n${contract}\n\n## 真正的问题\n\n### 保存后内容全部消失\n`,
  );
  assert.equal(detail, "", `${head} 不是 \`## 结论\`，四栏再齐也不拆`);
  assert.match(summary, /保存后内容全部消失/, "问题必须留在首屏");
}

// 缺一段就不算：三段齐全也不行，契约签名没有「差不多」这一档。
{
  const three = contract.split("\n**不拦验收、但你该知道的**")[0];
  assert.equal(
    splitReviewReport(`# 报告\n\n## 结论\n\n${three}\n\n## 明细\n\n略\n`).detail,
    "",
    "四段缺一段都不构成契约签名",
  );
}

// 栏目名写在正文里不算数：契约要的是那四段**结构**真的在，不是那几个词出现过。
//
// 提过栏目名就一律整篇铺开，不降到「旧格式的结论节」那一档——正文提及凑不出签名，却
// 足以说明有人在照新格式写，后面那个 `##` 很可能就是问题小节。下面第二份把这一点摆明：
// 同样是正文提及，第二个 `##` 装的是问题。
{
  const prose = [
    "# 报告",
    "",
    "## 结论",
    "",
    "我按模板核对了能不能验收、现在什么能用了、必须修的问题、不拦验收但你该知道的这四栏，",
    "都写在下面的分析里了。",
    "",
    "## 明细",
    "",
    "略",
  ].join("\n");
  assert.equal(splitReviewReport(prose).detail, "", "顺口提到四个栏目名不构成契约签名");
}
{
  const proseThenProblem = [
    "# 报告",
    "",
    "## 结论",
    "",
    "必须修的问题写在下面。",
    "",
    "## 真正的问题",
    "",
    "### 导出内容仍是旧版本",
  ].join("\n");
  const { summary, detail, kind } = splitReviewReport(proseThenProblem);
  assert.equal(kind, "whole", "正文提过栏目名 = 新格式写坏了，不是旧格式");
  assert.equal(detail, "");
  assert.match(summary, /导出内容仍是旧版本/, "问题必须留在首屏");
}

// 「开头像」不算数：标签必须完整闭合。第 3 轮审查报告里的反例——四行加粗标签各自只是
// 相近措辞，只锚定行首时照样凑齐签名，而真正的问题在后面那个 `##` 里。
{
  const nearMiss = [
    "# 报告",
    "",
    "## 结论",
    "",
    "**能不能验收不了**：这只是相近措辞，不是固定栏目。",
    "**现在什么能用了没有写清**：基础页面可以打开。",
    "**必须修的问题也许在后面**：请继续往下看。",
    "**不拦验收之外的备注**：没有。",
    "",
    "## 真正的问题",
    "",
    "### 导出后所有修改都会消失",
  ].join("\n");
  const { summary, detail } = splitReviewReport(nearMiss);
  assert.equal(detail, "", "标签没闭合、只是开头像，不构成契约签名");
  assert.match(summary, /导出后所有修改都会消失/, "问题必须留在首屏");
}

// 把同样的续写挪到加粗**外面**：第 4 轮审查报告里的反例。只要求闭合 `**` 的那一版会
// 在第二组星号处收工、不管后面写了什么，于是这四行又凑齐一次签名。
{
  const trailing = [
    "# 报告",
    "",
    "## 结论",
    "",
    "**能不能验收**不了解的人先看这里",
    "**现在什么能用了**没有写清",
    "**必须修的问题**也许在后面",
    "**不拦验收、但你该知道的**之外还有备注",
    "",
    "## 真正的问题",
    "",
    "### 导出后所有修改都会消失",
  ].join("\n");
  const { summary, detail } = splitReviewReport(trailing);
  assert.equal(detail, "", "闭合加粗后面直接续写正文，不构成契约签名");
  assert.match(summary, /导出后所有修改都会消失/, "问题必须留在首屏");
}

// 逐栏单独验：任何一栏被续写就够破坏签名，不是只有四栏一起改才算。
for (const [label, broken] of [
  ["**能不能验收**", "**能不能验收**不了解的人先看这里"],
  ["**现在什么能用了**", "**现在什么能用了**没有写清"],
  ["**必须修的问题**", "**必须修的问题**也许在后面"],
  ["**不拦验收、但你该知道的**", "**不拦验收、但你该知道的**之外还有备注"],
]) {
  const source = contract.split("\n").find((line) => line.startsWith(label));
  assert.ok(source, `契约样本里应当有 ${label} 这一行`);
  const broke = contract.replace(source, broken);
  assert.equal(
    splitReviewReport(`# 报告\n\n## 结论\n\n${broke}\n\n## 明细\n\n略\n`).detail,
    "",
    `${label} 后面被续写就不该再认作契约`,
  );
}

// 第四栏写全「但你该知道的」才算：缩写成「不拦验收」会放「不拦验收之外的备注」进来。
{
  const abbreviated = contract.replace("**不拦验收、但你该知道的**", "**不拦验收之外的备注**");
  assert.equal(
    splitReviewReport(`# 报告\n\n## 结论\n\n${abbreviated}\n\n## 明细\n\n略\n`).detail,
    "",
    "第四栏不是固定标签就不算契约",
  );
}

// 加粗没闭合（`**能不能验收`）同样不算——那多半是排版事故，不是契约。
{
  const unclosed = contract.replace("**能不能验收**：", "**能不能验收：");
  assert.equal(
    splitReviewReport(`# 报告\n\n## 结论\n\n${unclosed}\n\n## 明细\n\n略\n`).detail,
    "",
    "加粗没闭合不构成契约签名",
  );
}

// 但加粗把冒号包进去是真实写法，得认：`**能不能验收：**不能 —— …`。
for (const colon of ["：", ":"]) {
  const inside = contract.replace("**能不能验收**：", `**能不能验收${colon}**`);
  assert.match(
    splitReviewReport(`# 报告\n\n## 结论\n\n${inside}\n\n## 明细\n\n略\n`).detail,
    /^## 明细/,
    `加粗包住「${colon}」仍属于契约`,
  );
}

// 第四栏的顿号写不写都认（`不拦验收但你该知道的`）。
{
  const noComma = contract.replace("不拦验收、但你该知道的", "不拦验收但你该知道的");
  assert.match(
    splitReviewReport(`# 报告\n\n## 结论\n\n${noComma}\n\n## 明细\n\n略\n`).detail,
    /^## 明细/,
    "第四栏省掉顿号仍属于契约",
  );
}

// 围栏里的加粗标签行同样不算——贴一份别人的报告当证据，不能把自己变成契约报告。
{
  const quoted = [
    "# 报告",
    "",
    "## 结论",
    "",
    "上一轮的报告长这样：",
    "",
    "```md",
    "**能不能验收**：可以",
    "**现在什么能用了**：略",
    "**必须修的问题**",
    "**不拦验收、但你该知道的**",
    "```",
    "",
    "## 明细",
    "",
    "略",
  ].join("\n");
  assert.equal(splitReviewReport(quoted).detail, "", "围栏里引用的标签行不是这份报告的结构");
}

// 只有 `## 结论` 一节、没有下文：没有明细就不该画出那个展开按钮。
{
  const only = `# 报告\n\n## 结论\n\n${contract}\n`;
  assert.equal(splitReviewReport(only).detail, "");
}

// 注释里留一份契约模板不算契约：那四行根本不会显示，用它凑签名等于拿看不见的字骗拆分。
{
  const templated = [
    "# 报告",
    "",
    "## 结论",
    "",
    "<!--",
    contract,
    "-->",
    "",
    "## 真正的问题",
    "",
    "### 导出后所有修改都会消失",
  ].join("\n");
  const { summary, detail } = splitReviewReport(templated);
  assert.equal(detail, "", "注释里的标签行不构成契约签名");
  assert.match(summary, /导出后所有修改都会消失/, "问题必须留在首屏");
}

// 块引用里的标签行不算签名（第 8 轮审查报告的反例）。CommonMark 允许引用段落的后续行
// 省掉 `>`，所以这四行源码看着顶格，解析树里整段都在 `blockquote` 里——拿它们凑签名，
// 这一份真正的问题就被折进明细。两种写法都要挡：省 `>` 的和每行都带 `>` 的。
for (const [kind, quote] of [
  ["省掉 `>` 的延续行", (line) => line],
  ["每行都带 `>`", (line) => `> ${line}`],
]) {
  const quoted = [
    "# 报告",
    "",
    "## 前言",
    "",
    "> 下面引用上一轮的结论格式：",
    ...contract.split("\n").filter((line) => line.trim()).map(quote),
    "",
    "## 真正的问题",
    "",
    "### 保存后你刚改的内容会全部消失",
  ].join("\n");
  const { summary, detail } = splitReviewReport(quoted);
  assert.equal(detail, "", `${kind}：引用里的标签行不是这份报告的结构`);
  assert.match(summary, /保存后你刚改的内容会全部消失/, `${kind}：问题必须留在首屏`);
}

// 嵌套一层的列表项同理：「上一轮报告的结论：」底下缩一格抄四行，跟块引用是同一种伪造。
// 认的只有顶层段落和顶层列表**直属**列表项里的段落。
{
  const nested = [
    "# 报告",
    "",
    "## 前言",
    "",
    "- 上一轮报告的结论：",
    ...contract.split("\n").filter((line) => line.trim()).map((line) => `  - ${line}`),
    "",
    "## 真正的问题",
    "",
    "### 保存后你刚改的内容会全部消失",
  ].join("\n");
  const { summary, detail } = splitReviewReport(nested);
  assert.equal(detail, "", "嵌套列表项里的标签行不构成契约签名");
  assert.match(summary, /保存后你刚改的内容会全部消失/, "问题必须留在首屏");
}

// 栏目是**独立的一段**，不是「某段里出现过这四个词」（第 9 轮审查报告的反例之一）。
// 一个普通说明段里顺手抄四行旧结论，按「节点覆盖的每一行都能参选」算就凑齐了签名。
{
  const prose = [
    "# 报告",
    "",
    "## 前言",
    "",
    "下面抄的是上一轮结论，不是本轮：",
    ...contract.split("\n").filter((line) => line.startsWith("**")),
    "",
    "## 真正的问题",
    "",
    "### 保存后你刚改的内容会全部消失",
  ].join("\n");
  const { summary, detail } = splitReviewReport(prose);
  assert.equal(detail, "", "说明段里抄的四行不构成契约签名");
  assert.match(summary, /保存后你刚改的内容会全部消失/, "问题必须留在首屏");
}

// 四栏挤在同一段里（中间没有空行）同样不算：那是一整段，不是四个栏目。
{
  const crammed = [
    "# 报告",
    "",
    "## 结论",
    "",
    ...contract.split("\n").filter((line) => line.startsWith("**")),
    "",
    "## 真正的问题",
    "",
    "### 保存后你刚改的内容会全部消失",
  ].join("\n");
  const { summary, detail } = splitReviewReport(crammed);
  assert.equal(detail, "", "四栏挤成一段不构成契约签名");
  assert.match(summary, /保存后你刚改的内容会全部消失/, "问题必须留在首屏");
}

// 顺序也是契约的一部分（`server/src/review-report-format.ts` 的规则表就是按这个次序
// 排的）。只问「四个标签各自出现过没有」时，完全倒着写也算数——那更像抄了一份别人的
// 结论，而不是按这份契约写的摘要。
{
  const labels = contract.split("\n").filter((line) => line.startsWith("**"));
  const reversed = [
    "# 报告",
    "",
    "## 结论",
    "",
    ...[...labels].reverse().flatMap((line) => [line, ""]),
    "## 真正的问题",
    "",
    "### 导出的视频仍然使用旧字幕",
  ].join("\n");
  const { summary, detail } = splitReviewReport(reversed);
  assert.equal(detail, "", "四栏倒序不构成契约签名");
  assert.match(summary, /导出的视频仍然使用旧字幕/, "问题必须留在首屏");
}

// 重样的也不算：同一栏写两遍说明这不是一份按契约写的摘要，宁可不拆。
{
  const repeated = `# 报告\n\n## 结论\n\n${contract}\n\n**能不能验收**：再说一遍\n\n## 明细\n\n略\n`;
  assert.equal(splitReviewReport(repeated).detail, "", "栏目重复不构成契约签名");
}

// 四个标签齐了还不够——得**证明问题本身就在摘要里**。第 10 轮的反例：摘要写着「不能 ——
// 有 1 条必须先修」「必须修的问题：见下方」，那一条却写成了下一个 `##`，于是首屏只剩
// 「见下方」，问题在折叠里。判据照契约本身来：要么每条问题一个小标题，要么只写「没有
// 发现问题」。
{
  const misplaced = [
    "# 报告",
    "",
    "## 结论",
    "",
    "**能不能验收**：不能 —— 有 1 条必须先修",
    "",
    "**现在什么能用了**：略",
    "",
    "**必须修的问题**：见下方",
    "",
    "**不拦验收、但你该知道的**：没有",
    "",
    "## 保存后你刚改的内容会全部消失",
    "",
    "你会遇到：点保存回到列表，刚写的东西没了。",
  ].join("\n");
  const { summary, detail } = splitReviewReport(misplaced);
  assert.equal(detail, "", "拿不出小标题也拿不出「没有发现问题」，就不能拆");
  assert.match(summary, /保存后你刚改的内容会全部消失/, "问题必须留在首屏");
}

// 别矫枉过正：没问题那一支照拆。契约给的固定文案就是「没有发现问题」六个字。
for (const [kind, column] of [
  ["单起一段", "**必须修的问题**\n\n没有发现问题"],
  ["写在同一行", "**必须修的问题**：没有发现问题"],
]) {
  const clean = [
    "# 报告",
    "",
    "## 结论",
    "",
    "**能不能验收**：可以",
    "",
    "**现在什么能用了**：烧录前会先等字幕落盘。",
    "",
    column,
    "",
    "**不拦验收、但你该知道的**：没有。",
    "",
    "## 明细",
    "",
    "略",
  ].join("\n");
  assert.match(splitReviewReport(clean).detail, /^## 明细/, `${kind}：没问题的报告照样要拆`);
}

// 拆分器据此拆，用户看到的却是另一回事。同一个道理第 7 轮已经栽过一次。
{
  const table = [
    "# 报告",
    "",
    "## 结论",
    "",
    "**能不能验收**：可以 |",
    "--- |",
    "**现在什么能用了**：略 |",
    "**必须修的问题**：没有 |",
    "**不拦验收、但你该知道的**：没有 |",
    "",
    "## 真正的问题",
    "",
    "### 导出的视频仍然使用旧字幕",
  ].join("\n");
  const { summary, detail } = splitReviewReport(table);
  assert.equal(detail, "", "表格里的四行不构成契约签名");
  assert.match(summary, /导出的视频仍然使用旧字幕/, "问题必须留在首屏");
}

// 四张各带分隔行的表格：这一份**只有装上 GFM 才认得出**。核心语法把它们读成四个段落，
// 每段首行正好是一个栏目、顺序还对——签名当场齐全，真正的问题被折进明细；页面上渲染出来
// 的却是四张表格。拆分和渲染用两套语法，分歧就长在这种地方。
{
  const tables = [
    "# 报告",
    "",
    "## 结论",
    "",
    "**能不能验收**：可以 | x",
    "--- | ---",
    "",
    "**现在什么能用了**：略 | x",
    "--- | ---",
    "",
    "**必须修的问题**：没有 | x",
    "--- | ---",
    "",
    "**不拦验收、但你该知道的**：没有 | x",
    "--- | ---",
    "",
    "## 真正的问题",
    "",
    "### 导出的视频仍然使用旧字幕",
  ].join("\n");
  const { summary, detail } = splitReviewReport(tables);
  assert.equal(detail, "", "表头里的四个栏目名不构成契约签名");
  assert.match(summary, /导出的视频仍然使用旧字幕/, "问题必须留在首屏");
}

// 列表符号打头的标签行也认：`- **能不能验收**：…` 是同一段结构，不是另一种写法。
{
  const bulleted = contract.replace(/^\*\*/gm, "- **");
  assert.match(
    splitReviewReport(`# 报告\n\n## 结论\n\n${bulleted}\n\n## 明细\n\n略\n`).detail,
    /^## 明细/,
    "标签行前面带列表符号仍属于契约",
  );
}

// 空报告不该炸。
assert.deepEqual(splitReviewReport(""), { summary: "", detail: "", kind: "whole" });

console.log("review report sections ok");
