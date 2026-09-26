// 报告摘要/明细的拆分契约。钉住它是因为契约横跨前后端：`server/src/review-report-format.ts`
// 让审查者写出四段固定摘要，这里认那四段拆。任何一边漂了，用户要么看见整篇合规证明，
// 要么更糟——发现被藏掉。所以「认不出契约时必须整篇铺开」是重点用例。
//
// 别把判据改回「标题里有没有『结论』」：那一版放行过两份真实报告，把【高】/高危发现
// 整批折叠进了写着「验证过程、证据、清场记录」的按钮下面（下面有用例钉住）。
import assert from "node:assert/strict";
import { splitReviewReport } from "../src/components/reviewReportSections.ts";

const conforming = [
  "# 第 4 轮自动验证报告",
  "",
  "## 结论",
  "",
  "**能不能验收**：不能 —— 有 1 条必须先修，最要命的是烧录用了旧字幕",
  "",
  "**现在什么能用了**：深色主题下卡片不再出现亮紫白空位。",
  "",
  "## 被审范围与基线",
  "",
  "- 基线 `d7ee0b07`",
  "",
  "## 清场",
  "已停掉 5175。",
].join("\n");

{
  const { summary, detail } = splitReviewReport(conforming);
  assert.match(summary, /## 结论/);
  assert.match(summary, /不能 —— 有 1 条必须先修/);
  // 摘要段止于第二个 `##`：明细一行都不许漏进来。
  assert.doesNotMatch(summary, /被审范围|基线|清场|d7ee0b07/);
  // 明细从第二个 `##` 起，后面的小节全都在——折叠不是丢弃。
  assert.match(detail, /^## 被审范围与基线/);
  assert.match(detail, /## 清场/);
  assert.match(detail, /已停掉 5175。/);
  assert.equal(`${summary}\n\n${detail}`.replace(/\s+/g, ""), conforming.replace(/\s+/g, ""));
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

// 契约认的是四段结构，不是标题措辞：标题怎么写都行，四段里出现两段才算数。
for (const head of ["## 结论", "## 结论：不能验收", "## 结论（第 3 轮）", "## 给人看的结论", "## 摘要"]) {
  const body = "**能不能验收**：可以\n\n**现在什么能用了**：登录能用了。";
  const { summary, detail } = splitReviewReport(`# 报告\n\n${head}\n\n${body}\n\n## 明细\n\n略\n`);
  assert.match(summary, new RegExp(head.slice(3)), `${head} 那一节本身要留在摘要里`);
  assert.match(detail, /^## 明细/, `${head} 带着四段结构就该被认作摘要节`);
}

// 只凑出一段不算：一句话里偶然出现某个词不能触发折叠。
{
  const oneMark = "# 报告\n\n## 结论\n\n这里只提到必须修的问题这几个字。\n\n## 明细\n\n略\n";
  assert.equal(splitReviewReport(oneMark).detail, "", "只命中一段标记不构成契约签名");
}

// 只有 `## 结论` 一节、没有下文：没有明细就不该画出那个展开按钮。
{
  const only = "# 报告\n\n## 结论\n\n**能不能验收**：可以\n";
  assert.equal(splitReviewReport(only).detail, "");
}

// 围栏里的 `## xxx` 是被审代码或命令输出，不是小节标题——拿它当分界会把摘要腰斩。
{
  const fenced = [
    "# 报告",
    "",
    "## 结论",
    "",
    "**能不能验收**：可以。执行者贴的原文如下：",
    "",
    "**现在什么能用了**：登录能用了。",
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
  const nested = "# 报告\n\n## 结论\n\n**能不能验收**：可以\n\n**现在什么能用了**：略\n\n```\n~~~\n## 输出里的井号\n~~~\n```\n\n## 明细\n\n略\n";
  assert.match(splitReviewReport(nested).detail, /^## 明细/);
}

// `###` 是小节内部结构（「必须修的问题」下面每条问题一个小标题），不构成明细分界。
{
  const h3 = "# 报告\n\n## 结论\n\n**能不能验收**：不能\n\n**必须修的问题**\n\n### 问题 1\n\n你会遇到：烧录出旧字幕\n\n## 明细\n\n略\n";
  const { summary, detail } = splitReviewReport(h3);
  assert.match(summary, /### 问题 1/);
  assert.match(summary, /烧录出旧字幕/);
  assert.match(detail, /^## 明细/);
}

// 空报告不该炸。
assert.deepEqual(splitReviewReport(""), { summary: "", detail: "" });

console.log("review report sections ok");
