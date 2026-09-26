// 报告摘要/明细的拆分契约。钉住它是因为契约横跨前后端：`server/src/review-report-format.ts`
// 让审查者写出四段固定摘要，这里认那四段拆。任何一边漂了，用户要么看见整篇合规证明，
// 要么更糟——发现被藏掉。所以「认不出契约时必须整篇铺开」是重点用例。
//
// 三条**别再走回头路**的判据，各自有用例钉在下面：
// ① 别改回「标题里有没有『结论』」——那一版放行过两份真实报告，把【高】/高危发现整批
//    折叠进了写着「验证过程、证据、清场记录」的按钮下面。
// ② 别把签名放宽。这个判据已经被放宽过三次，每次都被审查抓回来，后果一模一样：
//    「命中任意两段」让半套摘要过关；「只锚定行首」让 `**能不能验收不了**` 过关；
//    「只要求闭合 `**`」让 `**能不能验收**不了解的人先看这里` 过关。首屏都写着有问题，
//    问题本身都在折叠里。认不出只是啰嗦，认错了是骗人——拿不准就不拆。
// ③ 围栏的开头和结尾别再共用一条判据。共用时代码块里一行 ```… 就能把围栏提前关掉，
//    块里的 `## xxx` 于是成了拆点——这是「认错了」的另一个入口，后果同 ②。
import assert from "node:assert/strict";
import { splitReviewReport } from "../src/components/reviewReportSections.ts";

/** 四个固定小标题的加粗标签行——契约签名就是它们齐全地出现在第一节里。 */
const contract = [
  "**能不能验收**：不能 —— 有 1 条必须先修，最要命的是烧录用了旧字幕",
  "",
  "**现在什么能用了**：深色主题下卡片不再出现亮紫白空位。",
  "",
  "**必须修的问题**",
  "",
  "### 烧录出来的成片用的是你改之前的字幕",
  "",
  "你会遇到：改完字幕立刻点烧录，导出的视频里还是上一版。",
  "",
  "**不拦验收、但你该知道的**",
  "",
  "- 删除项目后整个网格会闪一下。",
].join("\n");

const conforming = ["# 第 4 轮自动验证报告", "", "## 结论", "", contract, "", "## 被审范围与基线", "", "- 基线 `d7ee0b07`", "", "## 清场", "已停掉 5175。"].join("\n");

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

// 反例一（真实报告 `yz74LehaZzwl/H1MQnmqKzCSl/round-1` 的骨架）：首节标题含「结论」，
// 意思却正相反——「先说**结论之外的**」。按标题拆会把两条【高】折叠掉，首屏只剩
// 「做对的部分」，而那个折叠按钮上写着「验证过程、证据、清场记录」，等于骗用户里面
// 只有合规证明。
{
  const opposite = [
    "# 第 1 轮审查",
    "",
    "结论：**verify_failed**，2 个高优先级问题。",
    "",
    "## 0. 先说结论之外的：这轮做对的部分",
    "",
    "核心流程已跑通，新增回归测试全部通过。",
    "",
    "## 1. 【高】身份页高内容屏：顶部被裁，而且滚不回去",
    "",
    "复现：……",
  ].join("\n");
  const { summary, detail } = splitReviewReport(opposite);
  assert.equal(detail, "", "「先说结论之外的」不是摘要契约，不许拆");
  assert.match(summary, /【高】身份页高内容屏/, "高优先级发现必须留在首屏，不能被折叠吃掉");
}

// 反例二（真实报告 `KyF5hukfZ5D9/RJPSXRqyJIo2/round-1` 的骨架）：首节确实在讲结论，
// 但只讲了**正面那半**，高危发现全在后面的 `##` 里。
{
  const positiveOnly = [
    "# 第 1 轮审查",
    "",
    "## 一、先说结论：核心功能是真的能用",
    "",
    "主链路验证通过。",
    "",
    "## 二、Finding 1（高危 · 已确定复现）：所有 codex 任务开机即死",
    "",
    "复现：……",
  ].join("\n");
  const { summary, detail } = splitReviewReport(positiveOnly);
  assert.equal(detail, "", "只讲正面那半的「先说结论」不是摘要契约，不许拆");
  assert.match(summary, /高危/, "高危发现必须留在首屏");
}

// 存量报告：第一个 `##` 跟结论无关（ascut `LqhF7g_rqANy` 第 1 轮就是这样，结论混在开头的
// 无序列表里，缺陷在第三个 `##`）。拆点是第二个 `##`，硬拆会把「三、发现的缺陷」整段
// 收进折叠，藏发现比让人多滚两屏严重得多。
{
  const legacy = "# 第 1 轮逻辑审查报告\n\n- 结论：**verify_failed**\n\n## 一、改动范围\n\n27 个文件。\n\n## 三、发现的缺陷\n\n缺陷 1……\n";
  const { summary, detail } = splitReviewReport(legacy);
  assert.equal(summary, legacy);
  assert.equal(detail, "");
}

// 同理：`zs6JLcw1VAdr` 的全部发现就在第一个 `##`（「Finding」）里，一律拆会把整份报告
// 的发现藏光。这是「认不出契约就不拆」这一档存在的理由，不是疏漏。
{
  const findingFirst = "# 第 10 轮逻辑审查报告\n\n结论：**verify_failed**。\n\n## Finding\n\n### P1：……\n\n## 清理\n\n略\n";
  const { summary, detail } = splitReviewReport(findingFirst);
  assert.match(summary, /P1/, "发现写在第一个 `##` 里时必须整篇铺开，不能被折叠吃掉");
  assert.equal(detail, "");
}

// 契约认的是四段结构，不是标题措辞：标题怎么写都行，四段齐全才算数。
for (const head of ["## 结论", "## 结论：不能验收", "## 结论（第 3 轮）", "## 给人看的结论", "## 摘要"]) {
  const { summary, detail } = splitReviewReport(`# 报告\n\n${head}\n\n${contract}\n\n## 明细\n\n略\n`);
  assert.match(summary, new RegExp(head.slice(3)), `${head} 那一节本身要留在摘要里`);
  assert.match(detail, /^## 明细/, `${head} 带着完整四段就该被认作摘要节`);
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

// 围栏里的 `## xxx` 是被审代码或命令输出，不是小节标题——拿它当分界会把摘要腰斩。
{
  const fenced = [
    "# 报告",
    "",
    "## 结论",
    "",
    contract,
    "",
    "执行者贴的原文如下：",
    "",
    "```md",
    "## 这是被审文件里的标题",
    "```",
    "",
    "继续写结论。",
    "",
    "## 真正的明细",
    "",
    "略",
  ].join("\n");
  const { summary, detail } = splitReviewReport(fenced);
  assert.match(summary, /这是被审文件里的标题/);
  assert.match(summary, /继续写结论。/);
  assert.match(detail, /^## 真正的明细/);
}

// 围栏用同种记号配对：``` 块里贴的 ~~~ 不能把围栏提前关掉。
{
  const nested = `# 报告\n\n## 结论\n\n${contract}\n\n\`\`\`\n~~~\n## 输出里的井号\n~~~\n\`\`\`\n\n## 明细\n\n略\n`;
  assert.match(splitReviewReport(nested).detail, /^## 明细/);
}

// 闭合判据必须比开头严（第 6 轮审查报告的反例）。CommonMark 里开头允许跟信息串
// （```text），闭合却只允许同种记号加空白；共用一条宽松正则时，代码块里**任何一行以
// 三个反引号打头的内容**都会把围栏提前关掉，于是代码里的 `## xxx` 成了第二个 `##`——
// 报告从那里腰斩，真正的问题被折进明细，还被当成代码渲染。
for (const [kind, mark] of [["反引号", "```"], ["波浪线", "~~~"]]) {
  const report = [
    "# 报告",
    "",
    "## 结论",
    "",
    "**能不能验收**：不能 —— 有 1 条必须先修",
    "**现在什么能用了**：深色主题下卡片正常了。",
    "**不拦验收、但你该知道的**：没有。",
    "**必须修的问题**",
    "",
    "执行者贴的报错原文如下：",
    "",
    `${mark}text`,
    `${mark}这一行仍是代码内容，不是闭合围栏`,
    "## 命令输出里的井号",
    mark,
    "",
    "### 保存后你刚改的内容会全部消失",
    "",
    "## 明细",
    "",
    "略",
  ].join("\n");
  const { summary, detail } = splitReviewReport(report);
  assert.match(summary, /保存后你刚改的内容会全部消失/, `${kind}：真正的问题必须留在首屏`);
  assert.match(summary, /命令输出里的井号/, `${kind}：代码内容里的 \`##\` 不是小节标题`);
  assert.match(detail, /^## 明细/, `${kind}：拆点是那个真的二级标题`);
}

// 真闭合还是要认：同种记号、不短于开头、后面只有空白（更长、带尾随空格都算）。
// 认不出闭合会把后面整篇都吞进围栏，`## 明细` 也就成了代码——这一档同样不许漂。
{
  const closed = `# 报告\n\n## 结论\n\n${contract}\n\n\`\`\`text\n略\n\`\`\`\`   \n\n## 明细\n\n略\n`;
  assert.match(splitReviewReport(closed).detail, /^## 明细/, "更长的闭合记号加尾随空格仍是闭合");
}

// Markdown 允许 ATX 标题前有 0–3 个空格，认不出只是白白丢掉折叠收益（不藏内容）。
for (const pad of ["", " ", "  ", "   "]) {
  const padded = `# 报告\n\n${pad}## 结论\n\n${contract}\n\n${pad}## 明细\n\n略\n`;
  assert.match(
    splitReviewReport(padded).detail,
    /^\s{0,3}## 明细/,
    `标题前 ${pad.length} 个空格仍是标题`,
  );
}

// 4 个空格起就是缩进代码块，不是标题——认成标题就可能拆在代码中间。
{
  const indented = `# 报告\n\n    ## 结论\n\n${contract}\n\n    ## 明细\n\n略\n`;
  assert.equal(splitReviewReport(indented).detail, "", "4 空格缩进的是代码块，不构成分界");
}

// `###` 是小节内部结构（「必须修的问题」下面每条问题一个小标题），不构成明细分界。
{
  const { summary, detail } = splitReviewReport(`# 报告\n\n## 结论\n\n${contract}\n\n## 明细\n\n略\n`);
  assert.match(summary, /### 烧录出来的成片/);
  assert.match(summary, /改完字幕立刻点烧录/);
  assert.match(detail, /^## 明细/);
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

// Windows 上生成的报告（CRLF）必须一视同仁。踩过的坑不在换行本身，而在正则：`\r` 是
// 行终结符，`.` 不匹配它、不带 `m` 的 `$` 只认串尾，于是 `## 结论\r` 一个标题都认不出，
// 整份合规报告掉进「认不出契约」那条降级路径——首屏全是基线和命令输出，连按钮都没有。
{
  const crlf = conforming.replace(/\n/g, "\r\n");
  const { summary, detail } = splitReviewReport(crlf);
  assert.match(summary, /## 结论/, "CRLF 报告同样要拆出摘要");
  assert.match(summary, /烧录出来的成片/, "问题留在摘要里");
  assert.doesNotMatch(summary, /被审范围|d7ee0b07|清场/, "技术记录不该留在摘要里");
  assert.match(detail, /^## 被审范围与基线/, "明细从第二个 `##` 起");
  // 返回的正文跟入参逐字节一致：认 CRLF 不等于替换用户的换行。
  assert.ok(detail.includes("\r\n"), "切片必须用原始行，别把 CRLF 悄悄改成 LF");
  assert.equal(`${summary}\r\n\r\n${detail}`.replace(/\s+/g, ""), crlf.replace(/\s+/g, ""));
}

// 认不出契约的 CRLF 报告同样整篇铺开（降级路径不因换行而变）。
{
  const legacyCrlf = "# 第 1 轮\r\n\r\n## 一、改动范围\r\n\r\n27 个文件。\r\n\r\n## 三、发现的缺陷\r\n\r\n缺陷 1……\r\n";
  const { summary, detail } = splitReviewReport(legacyCrlf);
  assert.equal(summary, legacyCrlf, "拆不动时原样返回，一个字节都不动");
  assert.equal(detail, "");
}

// 空报告不该炸。
assert.deepEqual(splitReviewReport(""), { summary: "", detail: "" });

console.log("review report sections ok");
