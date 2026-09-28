// 一份报告**是不是照 ash 那套格式写的**——纯结构签名判据（`reviewReportFormat.ts`）。
// 「哪个 `##` 是分界」在 `test-review-report-boundary.mjs`，认不出格式时折到哪在
// `test-review-report-fallback.mjs`，折叠按钮**能说什么**在 `test-review-report-claim.mjs`。
//
// 这道闸决定的是**切在哪**：四栏齐全按序 → 从第二个 `##` 起切；一个栏目名都没提过 →
// 旧格式，同样从第二个 `##` 起切但按钮不宣称；**提过却凑不齐 → 整篇铺开**。最后那一档
// 是重点：那说明有人在照新格式写、只是没写对，这类报告的问题本来就该写在结论节里，
// 从第二个 `##` 起切会连问题一起切走（第 2 轮把第三栏误写成 `## 必须修的问题`、第 10 轮
// 把那条问题写成 `##`，都是这个形状）。
//
// 判据只读解析树——「这个块是段落还是引用/代码/表格」「这个标题的全文是不是那四个词」。
// 十轮复审里被逐条攻破的是另一套东西：从正文里猜作者到底有没有说可以验收。那套已于
// 2026-09-28 整体退役，换成读 `free_review_rounds.conclusion`（来由写在
// `reviewReportSections.ts` 头上）。这一份剩下的判据一次都没被攻破过,所以原样留着。
//
// 四条别再走回头路的判据：
// ① 别拿标题**代替**四栏。「标题里有没有『结论』」那一版放行过两份真实报告，把【高】/
//    高危发现整批切进了折叠。首节标题是**又一道**闸，不是四栏的替代品。
// ② 别把签名放宽。它被放宽过三次，每次都被审查抓回来：「命中任意两段」让半套摘要过关；
//    「只锚定行首」让 `**能不能验收不了**` 过关；「只要求闭合 `**`」让 `**能不能验收**
//    不了解的人先看这里` 过关。拿不准就整篇铺开。
// ③ 「哪些行有资格当契约标记」别改回黑名单。「排除代码块和 HTML 块、剩下的都算」漏过块
//    引用——引用段落的后续行可以省掉 `>`，源码看着顶格，解析树里整段在 blockquote 里。
//    白名单漏掉一种写法只是不切，黑名单漏掉一种是把问题切走。
// ④ 签名要认「四个独立栏目、齐全按序不重样」，不是「这四个词都出现过」。只收节点**起始
//    行**——收整段时，一个说明段里顺手抄四行旧结论就够签名了；只验集合不验顺序时，四栏
//    完全倒着写也算数。两种都是抄件，不是按契约写的摘要。
import assert from "node:assert/strict";
import { splitReviewReport } from "../src/components/reviewReportSections.ts";
import { contract, conforming, headingContract } from "./fixtures/review-report-contract.mjs";

// 这份文件管的是**切在哪**。按钮说什么由权威结论决定，跟签名无关（那一档在
// `test-review-report-claim.mjs`），所以统一按「这一轮通过了」调用——只有这个取值下
// `contract` 这一档才可能出现，签名放行没放行才看得出来。
const split = (text, conclusion = "verified") => splitReviewReport(text, conclusion);

{
  const { summary, detail, kind } = split(conforming);
  assert.equal(kind, "contract");
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
// 放宽成「任意两段」时这份会被切，而切点正好落在「必须修的问题」上——首屏写着「有 1 条
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
  const { summary, kind } = split(half);
  assert.equal(kind, "whole", "四段缺一段就不是这套格式，不许切");
  assert.match(summary, /导出内容仍是旧版本/, "问题必须留在首屏——半套摘要宁可整篇铺开");
}

// 首节标题本身也是一道闸：prompt 要求「报告开头必须先写一节 `## 结论`（就用这四个字
// 起头）」。第 10 轮的反例是一份开头写「## 前言」、里面整段抄着上一轮四项结论的报告——
// 四栏各自独立成段、顺序还对，光验四栏就照样放行。
{
  const { detail } = split(`# 报告\n\n## 结论\n\n${contract}\n\n## 明细\n\n略\n`);
  assert.match(detail, /^## 明细/, "`## 结论` + 完整四栏才切");
}
for (const head of ["## 结论：不能验收", "## 结论（第 3 轮）", "## 给人看的结论", "## 摘要", "## 前言"]) {
  const { summary, kind } = split(
    `# 报告\n\n${head}\n\n${contract}\n\n## 真正的问题\n\n### 保存后内容全部消失\n`,
  );
  assert.equal(kind, "whole", `${head} 不是「这是结论节」的声明，四栏再齐也不切`);
  assert.match(summary, /保存后内容全部消失/, "问题必须留在首屏");
}

// 缺一段就不算：三段齐全也不行，签名没有「差不多」这一档。
{
  const three = contract.split("\n**不拦验收、但你该知道的**")[0];
  assert.equal(
    split(`# 报告\n\n## 结论\n\n${three}\n\n## 明细\n\n略\n`).kind,
    "whole",
    "四段缺一段都凑不出签名",
  );
}

// 栏目名写在正文里不算数：要的是那四段**结构**真的在，不是那几个词出现过。
//
// 提过栏目名就一律整篇铺开，不降到「旧格式的结论节」那一档——正文提及凑不出签名，却
// 足以说明有人在照新格式写，后面那个 `##` 很可能就是问题小节。下面第二份把这一点摆明：
// 同样是正文提及，第二个 `##` 装的就是问题。
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
  assert.equal(split(prose).kind, "whole", "顺口提到四个栏目名凑不出签名");
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
  const { summary, kind } = split(proseThenProblem);
  assert.equal(kind, "whole", "正文提过栏目名 = 新格式写坏了，不是旧格式");
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
  const { summary, kind } = split(nearMiss);
  assert.equal(kind, "whole", "标签没闭合、只是开头像，凑不出签名");
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
  const { summary, kind } = split(trailing);
  assert.equal(kind, "whole", "闭合加粗后面直接续写正文，凑不出签名");
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
    split(`# 报告\n\n## 结论\n\n${broke}\n\n## 明细\n\n略\n`).kind,
    "whole",
    `${label} 后面被续写就不该再认`,
  );
}

// 第四栏写全「但你该知道的」才算：缩写成「不拦验收」会放「不拦验收之外的备注」进来。
{
  const abbreviated = contract.replace("**不拦验收、但你该知道的**", "**不拦验收之外的备注**");
  assert.equal(
    split(`# 报告\n\n## 结论\n\n${abbreviated}\n\n## 明细\n\n略\n`).kind,
    "whole",
    "第四栏不是固定标签就不算",
  );
}

// 加粗没闭合（`**能不能验收`）同样不算——那多半是排版事故。
{
  const unclosed = contract.replace("**能不能验收**：", "**能不能验收：");
  assert.equal(
    split(`# 报告\n\n## 结论\n\n${unclosed}\n\n## 明细\n\n略\n`).kind,
    "whole",
    "加粗没闭合凑不出签名",
  );
}

// 但加粗把冒号包进去是真实写法，得认：`**能不能验收：**不能 —— …`。
for (const colon of ["：", ":"]) {
  const inside = contract.replace("**能不能验收**：", `**能不能验收${colon}**`);
  assert.match(
    split(`# 报告\n\n## 结论\n\n${inside}\n\n## 明细\n\n略\n`).detail,
    /^## 明细/,
    `加粗包住「${colon}」仍算数`,
  );
}

// 第四栏的顿号写不写都认（`不拦验收但你该知道的`）。
{
  const noComma = contract.replace("不拦验收、但你该知道的", "不拦验收但你该知道的");
  assert.match(
    split(`# 报告\n\n## 结论\n\n${noComma}\n\n## 明细\n\n略\n`).detail,
    /^## 明细/,
    "第四栏省掉顿号仍算数",
  );
}

// 围栏里的加粗标签行同样不算——贴一份别人的报告当证据，不能把自己变成契约报告。
{
  const fenced = [
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
  assert.equal(split(fenced).kind, "whole", "围栏里引用的标签行不是这份报告的结构");
}

// 只有 `## 结论` 一节、没有下文：没有明细就不该画出那个展开按钮。
{
  const only = `# 报告\n\n## 结论\n\n${contract}\n`;
  assert.equal(split(only).detail, "");
}

// 注释里留一份契约模板不算：那四行根本不会显示，用它凑签名等于拿看不见的字骗切分。
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
  const { summary, kind } = split(templated);
  assert.equal(kind, "whole", "注释里的标签行凑不出签名");
  assert.match(summary, /导出后所有修改都会消失/, "问题必须留在首屏");
}

// 块引用里的标签行不算签名（第 8 轮审查报告的反例）。CommonMark 允许引用段落的后续行
// 省掉 `>`，所以这四行源码看着顶格，解析树里整段都在 `blockquote` 里——拿它们凑签名，
// 这一份真正的问题就被切进明细。两种写法都要挡：省 `>` 的和每行都带 `>` 的。
for (const [kind, quote] of [
  ["省掉 `>` 的延续行", (line) => line],
  ["每行都带 `>`", (line) => `> ${line}`],
]) {
  const quoted = [
    "# 报告",
    "",
    "## 结论",
    "",
    "> 下面引用上一轮的结论格式：",
    ...contract.split("\n").filter((line) => line.trim()).map(quote),
    "",
    "## 真正的问题",
    "",
    "### 保存后你刚改的内容会全部消失",
  ].join("\n");
  const { summary, kind: tier } = split(quoted);
  assert.equal(tier, "whole", `${kind}：引用里的标签行不是这份报告的结构`);
  assert.match(summary, /保存后你刚改的内容会全部消失/, `${kind}：问题必须留在首屏`);
}

// 嵌套一层的列表项同理：「上一轮报告的结论：」底下缩一格抄四行，跟块引用是同一种伪造。
// 认的只有顶层段落和顶层列表**直属**列表项里的段落。
{
  const nested = [
    "# 报告",
    "",
    "## 结论",
    "",
    "- 上一轮报告的结论：",
    ...contract.split("\n").filter((line) => line.trim()).map((line) => `  - ${line}`),
    "",
    "## 真正的问题",
    "",
    "### 保存后你刚改的内容会全部消失",
  ].join("\n");
  const { summary, kind } = split(nested);
  assert.equal(kind, "whole", "嵌套列表项里的标签行凑不出签名");
  assert.match(summary, /保存后你刚改的内容会全部消失/, "问题必须留在首屏");
}

// 栏目是**独立的一段**，不是「某段里出现过这四个词」（第 9 轮审查报告的反例之一）。
// 一个普通说明段里顺手抄四行旧结论，按「节点覆盖的每一行都能参选」算就凑齐了签名。
{
  const prose = [
    "# 报告",
    "",
    "## 结论",
    "",
    "下面抄的是上一轮结论，不是本轮：",
    ...contract.split("\n").filter((line) => line.startsWith("**")),
    "",
    "## 真正的问题",
    "",
    "### 保存后你刚改的内容会全部消失",
  ].join("\n");
  const { summary, kind } = split(prose);
  assert.equal(kind, "whole", "说明段里抄的四行凑不出签名");
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
  const { summary, kind } = split(crammed);
  assert.equal(kind, "whole", "四栏挤成一段凑不出签名");
  assert.match(summary, /保存后你刚改的内容会全部消失/, "问题必须留在首屏");
}

// 顺序也是签名的一部分（`server/src/review-report-format.ts` 的规则表就是按这个次序
// 排的）。只问「四个标签各自出现过没有」时，完全倒着写也算数——那更像抄了一份别人的
// 结论，而不是按这套格式写的摘要。
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
  const { summary, kind } = split(reversed);
  assert.equal(kind, "whole", "四栏倒序凑不出签名");
  assert.match(summary, /导出的视频仍然使用旧字幕/, "问题必须留在首屏");
}

// 重样的也不算：同一栏写两遍说明这不是一份按这套格式写的摘要，宁可不切。
{
  const repeated = `# 报告\n\n## 结论\n\n${contract}\n\n**能不能验收**：再说一遍\n\n## 明细\n\n略\n`;
  assert.equal(split(repeated).kind, "whole", "栏目重复凑不出签名");
}

// 表格里的四行不算：切分器按它切，用户看到的却是一张表。
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
  const { summary, kind } = split(table);
  assert.equal(kind, "whole", "表格里的四行凑不出签名");
  assert.match(summary, /导出的视频仍然使用旧字幕/, "问题必须留在首屏");
}

// 四张各带分隔行的表格：这一份**只有装上 GFM 才认得出**。核心语法把它们读成四个段落，
// 每段首行正好是一个栏目、顺序还对——签名当场齐全，真正的问题被切进明细；页面上渲染出来
// 的却是四张表格。切分和渲染用两套语法，分歧就长在这种地方。
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
  const { summary, kind } = split(tables);
  assert.equal(kind, "whole", "表头里的四个栏目名凑不出签名");
  assert.match(summary, /导出的视频仍然使用旧字幕/, "问题必须留在首屏");
}

// 列表符号打头的标签行也认：`- **能不能验收**：…` 是同一段结构，不是另一种写法。
{
  const bulleted = contract.replace(/^\*\*/gm, "- **");
  assert.match(
    split(`# 报告\n\n## 结论\n\n${bulleted}\n\n## 明细\n\n略\n`).detail,
    /^## 明细/,
    "标签行前面带列表符号仍算数",
  );
}

// —— 四栏的第二种真实写法：写成 `###` 小标题 ——
//
// 全库 1036 份里 4 份长这样（含本任务 `dB45LYOzuxnx/round-2` 的审查报告）。只认加粗版
// 时，这 4 份的整份技术记录重新铺满首屏。判据是标题可见文字**精确等于**栏目名（容一个
// 结尾冒号）——跟加粗版被抓过三次的**前缀**放宽不是一回事，全文相等混不进续写。
{
  const text = `## 结论\n\n${headingContract}\n\n## 被审范围\n\n- 基线 \`d7ee0b07\`\n\n## 清场\n\n已停掉 5175。\n`;
  const { summary, detail, kind } = split(text);
  assert.equal(kind, "contract", "小标题写法跟加粗写法一样确定，一样该认");
  assert.match(summary, /### 能不能验收/, "四栏留在首屏");
  assert.match(summary, /烧录出来的成片/, "问题本身留在首屏");
  assert.doesNotMatch(summary, /被审范围|d7ee0b07|清场/, "技术记录收进明细");
  assert.match(detail, /^## 被审范围/);
}
{
  const three = headingContract.split("\n### 不拦验收、但你该知道的")[0];
  assert.equal(
    split(`## 结论\n\n${three}\n\n## 明细\n\n略\n`).kind,
    "whole",
    "小标题写法缺一栏同样凑不出签名",
  );
}
{
  const reversed = [
    "### 不拦验收、但你该知道的", "", "没有。", "",
    "### 必须修的问题", "", "#### 1. 导出内容仍是旧版本", "", "你会遇到：……", "",
    "### 现在什么能用了", "", "略。", "",
    "### 能不能验收", "", "不能。",
  ].join("\n");
  const { summary, kind } = split(`## 结论\n\n${reversed}\n\n## 明细\n\n略\n`);
  assert.equal(kind, "whole", "四栏倒着写是抄件，不是按这套格式写的摘要");
  assert.match(summary, /导出内容仍是旧版本/, "问题必须留在首屏");
}
for (const bad of ["### 能不能验收不了", "### 能不能验收（详见下文）", "### 先说能不能验收"]) {
  const broke = headingContract.replace("### 能不能验收", bad);
  assert.equal(
    split(`## 结论\n\n${broke}\n\n## 明细\n\n略\n`).kind,
    "whole",
    `${bad} 不是固定栏目`,
  );
}
for (const colon of ["：", ":"]) {
  const withColon = headingContract.replace("### 能不能验收", `### 能不能验收${colon}`);
  assert.match(
    split(`## 结论\n\n${withColon}\n\n## 明细\n\n略\n`).detail,
    /^## 明细/,
    `小标题结尾带「${colon}」仍算数`,
  );
}

// 空报告不该炸。这条用**精确比对**而不是挑几个字段看，所以给返回结构加字段时它一定会
// 红——那正是要的：新字段在「什么都没切」这一档里得是什么，必须当场写清楚。
assert.deepEqual(split(""), { summary: "", more: "", rest: 0, aside: "", detail: "", kind: "whole" });

console.log("review report format ok");
