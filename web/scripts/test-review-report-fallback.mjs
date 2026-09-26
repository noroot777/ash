// 认不出契约时**折到哪**——降级判据。签名判据（一份报告算不算按契约写的）在
// `test-review-report-sections.mjs`，「哪个 `##` 是分界」在 `test-review-report-boundary.mjs`。
//
// 这一档存在的理由是用户点名要的结构保证：「证据抽屉默认只渲染第一个 `##` 之前的摘要，
// 底下一个『展开完整报告』——这样就算某轮审查者没照 prompt 写，你也不会被 46 行合规证明
// 糊一脸」。它跟被否掉的「按标题猜摘要在哪」差在两处，这两处就是全部安全边际：
//
// - **折的起点由「报告自己把判定写在哪」决定**，不由我们猜哪一节像摘要。首节标题就是
//   「这是结论」的声明（`## 结论` / `## Conclusion` / `## Verdict` / `## 结论：verify_failed`）
//   的报告，整节留在首屏、从第二个 `##` 起折；其它形态留第一个 `##` 之前的引子（抽查的
//   7 份 ascut 报告把 `结论：verify_failed —— N 个可复现缺陷` 写在那儿）。
// - **按钮什么都不宣称**（「展开完整报告」）。「展开技术明细（验证过程、证据、清场记录）」
//   那句话只有第一档配用——折叠里可能装着问题本身，替它背书就是撒谎。
//
// 四条别再走回头路的判据：
// ① 首屏凑不出**读得出字**的东西就整篇铺开：开头只有 `#` 标题、只有水平线/HTML 注释/
//    一张图而首节又不是报告自己声明的结论节，或者声明了却没有第二个 `##`——这些折完只剩
//    「标题 + 按钮」，比多滚两屏更糟。
// ② 「旧格式的结论节」只给**一个栏目名都没提过**的报告。提过就是新格式写坏了，问题本来
//    就该在结论节里，从第二个 `##` 起折会把问题一起折掉。
// ③ 折进去的一个字都不能少：`summary + detail` 拼回来必须等于原文。
// ④ 「声明这是结论节」是**整段标题全文相等**，不是「含结论二字」：`## 一、先说结论：核心
//    功能是真的能用` 这类首节只讲正面那半，认成结论节就会把后面的【高】折走。
import assert from "node:assert/strict";
import { splitReviewReport } from "../src/components/reviewReportSections.ts";

// 反例一（真实报告 `yz74LehaZzwl/H1MQnmqKzCSl/round-1` 的骨架）：首节标题含「结论」，
// 意思却正相反——「先说**结论之外的**」。按标题当契约拆会把两条【高】折叠掉，首屏只剩
// 「做对的部分」，而那个折叠按钮上写着「验证过程、证据、清场记录」，等于骗用户里面
// 只有合规证明。
//
// 现在它走第二档：拆点是**第一个** `##`，报告自己的开场结论留在首屏，「做对的部分」
// 跟两条【高】一起收进不作任何承诺的「展开完整报告」。两档的区别就在这两处——拆在哪，
// 以及按钮替不替折叠里的东西背书。
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
  const { summary, detail, kind } = splitReviewReport(opposite);
  assert.equal(kind, "lead", "「先说结论之外的」不是摘要契约，只能降级");
  assert.match(summary, /verify_failed\*\*，2 个高优先级问题/, "报告自己的开场结论留在首屏");
  assert.doesNotMatch(summary, /做对的部分|核心流程已跑通/, "「做对的部分」不许冒充摘要占着首屏");
  assert.match(detail, /^## 0\. 先说结论之外的/, "拆点是第一个 `##`，不是第二个");
  assert.match(detail, /【高】身份页高内容屏/);
}

// 反例二（真实报告 `KyF5hukfZ5D9/RJPSXRqyJIo2/round-1` 的骨架）：首节确实在讲结论，
// 但只讲了**正面那半**，高危发现全在后面的 `##` 里。这份开头除了标题什么都没写，首节
// 标题又不是报告自己声明的结论节（「一、先说结论：核心功能是真的能用」不等于「结论」），
// 于是连第二档都不给——整篇铺开。
//
// 第 4 轮想让「标题开场的报告一律留第一节」，这一份就是不能一律的理由：留了第一节，首屏
// 只剩「核心功能是真的能用」，高危发现进折叠。同形态的真实样本还有 `_wWMPNIsrXF7` 那份
// 111 行报告（首节是 `## 任务：…` 元数据，`## 2. 高优先级缺陷` 在后面）。
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
  const { summary, detail, kind } = splitReviewReport(positiveOnly);
  assert.equal(kind, "whole", "开头只有一个标题，首节又不是报告自己声明的结论节");
  assert.equal(detail, "");
  assert.match(summary, /高危/, "高危发现必须留在首屏");
}

// 存量报告的主力形态（ascut `LqhF7g_rqANy` 第 1 轮就是这样，结论混在开头的无序列表里，
// 缺陷在第三个 `##`）：抽查的 7 份真实报告全是这个样子——开头 7~12 行写明
// `结论：verify_failed —— N 个可复现缺陷`，后面 118~169 行是范围、命令、清场记录。
// 这正是用户点名要消灭的「46 行合规证明糊一脸」。
{
  const legacy = "# 第 1 轮逻辑审查报告\n\n- 结论：**verify_failed**\n\n## 一、改动范围\n\n27 个文件。\n\n## 三、发现的缺陷\n\n缺陷 1……\n";
  const { summary, detail, kind } = splitReviewReport(legacy);
  assert.equal(kind, "lead");
  assert.match(summary, /结论：\*\*verify_failed\*\*/, "开场那句判定留在首屏");
  assert.doesNotMatch(summary, /改动范围|27 个文件/, "第一个 `##` 起全部收进折叠");
  assert.match(detail, /^## 一、改动范围/);
  assert.match(detail, /缺陷 1/);
  assert.equal(
    `${summary}\n\n${detail}`.replace(/\s+/g, ""),
    legacy.replace(/\s+/g, ""),
    "折叠不是丢弃：一个字都不能少",
  );
}

// `zs6JLcw1VAdr` 那种**全部发现就在第一个 `##`** 里、而那一节又没有自报家门的报告，降级
// 后发现确实会落进折叠。这是明知的代价，不是疏漏：首屏仍有报告自己的 `verify_failed`，
// 按钮也不宣称里面只有合规证明。用户拍板过这个取舍——「就算某轮审查者没照 prompt 写，你
// 也不会被 46 行合规证明糊一脸」。要消灭这一档代价有两条路：让审查者按契约写（走第一
// 档），或者像下面那样把那一节老老实实叫「Findings」。
{
  const findingFirst = "# 第 10 轮逻辑审查报告\n\n结论：**verify_failed**。\n\n## 一、逐条核对\n\n### P1：……\n\n## 清理\n\n略\n";
  const { summary, detail, kind } = splitReviewReport(findingFirst);
  assert.equal(kind, "lead");
  assert.match(summary, /verify_failed/, "首屏至少得说清能不能验收");
  assert.match(detail, /P1/);
}

// 但首节老老实实叫 `## Findings` / `## 发现` 时，那就是报告自己声明「发现写在这儿」——
// 跟 `## 结论` 同一档，整节留在首屏、从第二个 `##` 起折。全库 323 份报告是这个形状，
// 尾部清一色是验证记录、浏览器通道和清理，正是用户点名不想被糊一脸的东西。
for (const [what, title] of [["英文 Findings", "## Findings"], ["单数 Finding", "## Finding"], ["中文发现", "## 发现"]]) {
  const text = `# 第 10 轮逻辑审查报告\n\n结论：**verify_failed**。\n\n${title}\n\n### P1：保存后内容会全部消失\n\n复现：……\n\n## 验证记录\n\n\`npm test\` 通过。\n\n## 清理\n\n已停掉 5175。\n`;
  const { summary, detail, kind } = splitReviewReport(text);
  assert.equal(kind, "lead", `${what}：报告自己声明了发现节，该折`);
  assert.match(summary, /P1：保存后内容会全部消失/, `${what}：发现必须留在首屏`);
  assert.doesNotMatch(summary, /验证记录|npm test|已停掉/, `${what}：技术记录照折`);
  assert.match(detail, /^## 验证记录/, `${what}：拆点是第二个 ` + "`##`");
  assert.equal(
    `${summary}\n\n${detail}`.replace(/\s+/g, ""),
    text.replace(/\s+/g, ""),
    `${what}：折叠不是丢弃`,
  );
}

// 开头连引子都没有的那两份真实报告（`Z7OFKHcfagfx` 74 行、`MOVQDcvhAC3-` 34 行）同理：
// 原本整篇铺开，现在发现那一节留首屏、范围和清理收进按钮。
{
  const noLead = "# Z7OFKHcfagfx round-1 logic review\n\n## Findings\n\n未发现可复现的行为缺陷。\n\n## Scope\n\n……\n\n## Cleanup\n\n……\n";
  const { summary, detail, kind } = splitReviewReport(noLead);
  assert.equal(kind, "lead", "首节自报家门时，标题开场也能折");
  assert.match(summary, /未发现可复现的行为缺陷/, "判定必须默认可见");
  assert.doesNotMatch(summary, /Scope|Cleanup/, "技术记录照折");
}

// 引子要的是**真有话说**，不是「标题下面空着」。只有一行 `#`、首节又不是声明的结论节
// （`## 发现 1：数据会丢` 是问题本身）时整篇铺开——首屏只剩标题加按钮，发现还被折走。
{
  const bare = "# 第 1 轮审查\n\n## 发现 1：数据会丢\n\n复现：……\n";
  assert.equal(splitReviewReport(bare).kind, "whole", "标题不算引子");
  assert.equal(splitReviewReport(bare).detail, "");
  assert.match(splitReviewReport(bare).summary, /数据会丢/, "发现必须留在首屏");
}

// 读不出字的也不算引子：首屏「一个标题 + 一坨看不懂的东西 + 一个按钮」比多滚两屏更糟。
for (const [what, lead] of [
  ["水平线", "---"],
  ["HTML 注释", "<!-- 内部备注：这份是旧格式 -->"],
  ["一张图", "![](./shot.png)"],
]) {
  const text = `# 第 1 轮审查\n\n${lead}\n\n## 发现 1：数据会丢\n\n复现：……\n`;
  const { kind, detail, summary } = splitReviewReport(text);
  assert.equal(kind, "whole", `引子只有${what}，读不出字，不算引子`);
  assert.equal(detail, "");
  assert.match(summary, /数据会丢/, `${what}：发现必须留在首屏`);
}

// 连一个顶层 `##` 都没有：没有拆点，整篇铺开。
{
  const flat = "# 第 1 轮审查\n\n结论：**verify_failed**。\n\n### 发现 1\n\n复现：……\n";
  assert.equal(splitReviewReport(flat).kind, "whole");
  assert.equal(splitReviewReport(flat).detail, "");
}

// 旧格式最常见的另一种形态（真实样本 `x3Jj_JW5SoXk/udvEI_K-2YiL/round-1`，全库同形态
// 的有 21 份）：一级标题 + 任务/日期/审查者三行 + `## 结论` + `verified` + `## 被审范围`。
// 判定写在 `## 结论` 那一节里，折在第一个 `##` 之前首屏就只剩元数据——「它到底过没过」
// 得点一下才知道。这一档改从**第二个** `##` 起折。
//
// 拿首节标题决定「摘要到哪为止」可以（那是报告自己的声明），拿它当「四栏契约成立」的
// 证据不行——后者的反例是 `## 0. 先说结论之外的`，两回事。
{
  const oldStyle = [
    "# 自由工作流第 1 轮审查报告",
    "",
    "任务：x3Jj_JW5SoXk / Grok 模型接入与刷新  ",
    "审查时间：2026-08-13  ",
    "审查者：独立逻辑审查（旁路回合）",
    "",
    "## 结论",
    "",
    "**verified。** 本轮固化需求已落地，未再复现会让验收失败的行为错误。",
    "",
    "## 被审范围",
    "",
    "工作树 `/Users/fjh/code/harness/.worktrees/x3Jj_JW5SoXk`，HEAD `45b8a02`。",
  ].join("\n");
  const { summary, detail, kind } = splitReviewReport(oldStyle);
  assert.equal(kind, "lead", "旧格式的结论节不构成契约，但仍然只能降级折");
  assert.match(summary, /## 结论/, "结论那一节整个留在首屏");
  assert.match(summary, /verified/, "「到底过没过」不许折进去");
  assert.doesNotMatch(summary, /被审范围|45b8a02/, "技术记录照折");
  assert.match(detail, /^## 被审范围/, "拆点是第二个 `##`");
  assert.equal(
    `${summary}\n\n${detail}`.replace(/\s+/g, ""),
    oldStyle.replace(/\s+/g, ""),
    "折叠不是丢弃",
  );
}

// 同形态但只有一个 `##`：折掉的就是整个结论节，那还不如整篇铺开。
{
  const only = "# 第 1 轮审查报告\n\n审查时间：2026-08-13\n\n## 结论\n\n**verified。** 没有发现缺陷。\n";
  assert.equal(splitReviewReport(only).kind, "whole", "没有第二个 `##` 就别折");
  assert.equal(splitReviewReport(only).detail, "");
}

// 「报告自己声明这一节是结论」跟它用哪种语言写没关系。判据本来写死成中文「结论」，于是
// `## Conclusion` / `## Verdict` 开场的报告一份都折不了——全库 13 份整篇铺开的报告里，
// 最长那份 222 行（`GM775FBSbr4y/YGXHJtf-Zvkz/round-1`）就是这个形状：`# 标题` 之后直接
// `## Conclusion`，后面 216 行是仓库状态、命令、原生验证证据和清场。这类报告恰恰是用户
// 点名要兜底的「审查者没完全照提示写」。
for (const [what, title, body] of [
  ["英文 Conclusion", "## Conclusion", "`verified`. No reproducible blocking defect."],
  ["英文 Verdict", "## Verdict", "verified"],
  ["判定写进标题", "## 结论：verify_failed", "完整构建失败，本轮必须报 `verify_failed`。"],
]) {
  const text = [
    "# GM775FBSbr4y free review round 1",
    "",
    title,
    "",
    body,
    "",
    "## Repository State",
    "",
    "`git status --short` → clean",
  ].join("\n");
  const { summary, detail, kind } = splitReviewReport(text);
  assert.equal(kind, "lead", `${what}：报告自己声明了结论节，该折`);
  assert.match(summary, new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${what}：结论那一节整个留在首屏`);
  assert.match(summary, /verif/, `${what}：「到底过没过」不许折进去`);
  assert.doesNotMatch(summary, /Repository State|clean/, `${what}：技术记录照折`);
  assert.match(detail, /^## Repository State/, `${what}：拆点是第二个 `.concat("`##`"));
  assert.equal(
    `${summary}\n\n${detail}`.replace(/\s+/g, ""),
    text.replace(/\s+/g, ""),
    `${what}：折叠不是丢弃`,
  );
}

// 但「声明」要的是**整段标题全文相等**（后缀只容协议自己的判定词），不是「含结论二字」。
// 放宽到前缀，上面反例一、二那两份真实报告就会被认成结论节，【高】跟着折进去。
for (const [what, title] of [
  ["正面那半", "## 结论：核心功能是真的能用"],
  ["先说结论之外的", "## 0. 先说结论之外的：这轮做对的部分"],
  ["任务元数据", "## 任务：查询 Claude 模型"],
  ["英文但不是判定词", "## Conclusion and next steps"],
  ["一条问题不是发现节", "## 发现 1：保存后内容会全部消失"],
]) {
  const text = `# 第 1 轮审查\n\n${title}\n\n主链路验证通过。\n\n## 2. 高优先级缺陷\n\nP1：保存后内容会全部消失。\n`;
  const { summary, kind } = splitReviewReport(text);
  assert.equal(kind, "whole", `${what}：不是报告自己声明的判定节，开头又没引子，只能整篇铺开`);
  assert.match(summary, /高优先级缺陷/, `${what}：缺陷必须留在首屏`);
}

// 全库还剩一份 110 行的长报告整篇铺开（`_wWMPNIsrXF7/5XWkSb3U0UQK/round-1`），这是**有意
// 留着**的，不是没修完：它首节是 `## 任务：查询 Claude 模型` 的元数据，`## 2. 高优先级
// 缺陷` 在后面。按「标题开场就留第一节」一律处理，首屏会只剩任务名，P1~P3 全进折叠——
// 长度不是判据，「报告把判定写在哪」才是。要折它只有一条路：让那份报告自己把判定写在
// 首节里。
{
  const metadataFirst = [
    "# 第 1 轮逻辑审查报告",
    "",
    "## 任务：查询 Claude 模型 (ash 中增加 Claude CLI 模型指定功能)",
    "",
    "审查对象：`ash/_wWMPNIsr`。",
    "",
    "## 1. 编译验证",
    "",
    "`npm run build` 通过。",
    "",
    "## 2. 高优先级缺陷",
    "",
    "### P1 行为缺陷 — 保存后内容会全部消失",
  ].join("\n");
  const { summary, kind } = splitReviewReport(metadataFirst);
  assert.equal(kind, "whole", "首节是元数据，折了首屏就只剩任务名");
  assert.match(summary, /P1 行为缺陷/, "缺陷必须留在首屏");
}

// 报告把严重度写在小节标题上时，那一节是什么就不用猜了——`## [中] 筛选状态下点击…` 自己
// 说了「这是一条问题、多严重」。开头连着的那几节问题全部留在首屏，从第一个没标的 `##`
// 起折（真实形态：`-MseXJQXVHVH` 的四轮报告，首节是问题、第二节就是「验证记录」，原先
// 整篇铺开四五十行）。
for (const [what, mark] of [["[中]", "[中]"], ["【高】", "【高】"], ["[P1]", "[P1]"]]) {
  const text = [
    "# 第 1 轮逻辑审查结论：未通过",
    "",
    `## ${mark} 点「常一起出现」会选中隐藏节点，结果区整体灰掉`,
    "",
    "复现：筛选状态下点详情面板的关联按钮。",
    "",
    "## 验证记录",
    "",
    "`npm test` 通过。",
    "",
    "## 浏览器验证",
    "",
    "无头会话，已清场。",
  ].join("\n");
  const { summary, detail, kind } = splitReviewReport(text);
  assert.equal(kind, "lead", `${what}：标题自己标了严重度，该折`);
  assert.match(summary, /结果区整体灰掉/, `${what}：问题必须留在首屏`);
  assert.doesNotMatch(summary, /验证记录|浏览器验证/, `${what}：技术记录照折`);
  assert.match(detail, /^## 验证记录/, `${what}：拆点是第一个没标严重度的 ` + "`##`");
  assert.equal(
    `${summary}\n\n${detail}`.replace(/\s+/g, ""),
    text.replace(/\s+/g, ""),
    `${what}：折叠不是丢弃`,
  );
}

// 标了严重度的有好几节时，**一节都不许折进去**——折的是它们后面的技术记录。
{
  const many = [
    "# 第 1 轮逻辑审查结论：未通过",
    "",
    "## [高] 保存后内容会全部消失",
    "",
    "复现：点保存回到列表。",
    "",
    "## [中] 导出内容仍是旧版本",
    "",
    "复现：改完字幕立刻点烧录。",
    "",
    "## 验证记录",
    "",
    "`npm test` 通过。",
  ].join("\n");
  const { summary, detail } = splitReviewReport(many);
  assert.match(summary, /保存后内容会全部消失/, "第一条留在首屏");
  assert.match(summary, /导出内容仍是旧版本/, "第二条也得留在首屏");
  assert.match(detail, /^## 验证记录/, "折的是技术记录");
}

// 但「标了严重度」要的是**打头就标**，不是标题里出现过。真实样本 `yz74LehaZzwl` 的首节
// 是 `## 0. 先说结论之外的：这轮做对的部分`，跟几条【高】是并列小节——从它折起才对，
// 认成问题小节会把「做对的部分」顶在首屏上。
{
  const numbered = [
    "# 第 1 轮审查",
    "",
    "结论：**verify_failed**，2 个高优先级问题。",
    "",
    "## 0. 先说结论之外的：这轮做对的部分",
    "",
    "核心流程已跑通。",
    "",
    "## 1. 【高】身份页高内容屏：顶部被裁",
    "",
    "复现：……",
  ].join("\n");
  const { summary, detail } = splitReviewReport(numbered);
  assert.doesNotMatch(summary, /做对的部分/, "序号打头的不算问题小节");
  assert.match(detail, /^## 0\. 先说结论之外的/, "拆点仍是第一个 `##`");
}

// 全篇每一节都标了严重度时没得可折——折了首屏就只剩一个标题。
{
  const allMarked = "# 第 1 轮审查\n\n## [高] 保存后内容会全部消失\n\n复现：……\n\n## [中] 导出内容仍是旧版本\n\n复现：……\n";
  const { kind, detail } = splitReviewReport(allMarked);
  assert.equal(kind, "whole", "没有技术记录可折就别折");
  assert.equal(detail, "");
}

// 但「新格式写坏了」不吃这一档：`## 结论` 里出现过栏目标签、却凑不齐/不按序/证明不了
// 问题在摘要里的，一律整篇铺开。这类报告的问题**本来就该写在结论节里**，从第二个 `##`
// 起折会连问题一起折掉——第 2 轮的半套摘要和第 10 轮的「问题误用 `##`」都是这个形状。
{
  const halfThenProblem = [
    "# 第 1 轮审查报告",
    "",
    "审查时间：2026-08-13",
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
  const { summary, detail, kind } = splitReviewReport(halfThenProblem);
  assert.equal(kind, "whole", "有标签却凑不齐 = 新格式写坏了，不是旧格式");
  assert.equal(detail, "");
  assert.match(summary, /导出内容仍是旧版本/, "问题必须留在首屏");
}

console.log("review report fallback ok");
