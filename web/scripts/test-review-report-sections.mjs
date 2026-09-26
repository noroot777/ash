// 报告摘要/明细的拆分契约。钉住它是因为契约横跨前后端：`server/src/review-report-format.ts`
// 让审查者把 `## 结论` 写在最前，这里认它拆。任何一边漂了，用户要么看见整篇合规证明，
// 要么更糟——内容被藏掉。所以「拆不动时必须整篇铺开」是重点用例。
import assert from "node:assert/strict";
import { splitReviewReport } from "../src/components/reviewReportSections.ts";

const conforming = [
  "# 第 4 轮自动验证报告",
  "",
  "## 结论",
  "",
  "**能不能验收**：不能 —— 有 1 条必须先修",
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

// 存量报告：第一个 `##` 不是结论（ascut `LqhF7g_rqANy` 第 1 轮就是这样，结论混在开头的
// 无序列表里）。拆不动就整篇铺开，宁可啰嗦也不能把内容藏进折叠里。
{
  const legacy = "# 第 1 轮逻辑审查报告\n\n- 结论：**verify_failed**\n\n## 一、改动范围\n\n27 个文件。\n";
  const { summary, detail } = splitReviewReport(legacy);
  assert.equal(summary, legacy);
  assert.equal(detail, "");
}

// 只有 `## 结论` 一节、没有下文：没有明细就不该画出那个展开按钮。
{
  const only = "# 报告\n\n## 结论\n\n**能不能验收**：可以\n";
  assert.equal(splitReviewReport(only).detail, "");
}

// 结论标题带后缀也认（`## 结论：不能验收`、`## 结论（第 3 轮）`）。
for (const head of ["## 结论：不能验收", "## 结论（第 3 轮）"]) {
  const { detail } = splitReviewReport(`# 报告\n\n${head}\n\n正文\n\n## 明细\n\n略\n`);
  assert.match(detail, /^## 明细/, `${head} 应当被认作结论节`);
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
  const nested = "# 报告\n\n## 结论\n\n```\n~~~\n## 输出里的井号\n~~~\n```\n\n## 明细\n\n略\n";
  assert.match(splitReviewReport(nested).detail, /^## 明细/);
}

// `###` 是小节内部结构（「必须修的问题」下面每条问题一个小标题），不构成明细分界。
{
  const h3 = "# 报告\n\n## 结论\n\n### 问题 1\n\n你会遇到：烧录出旧字幕\n\n## 明细\n\n略\n";
  const { summary, detail } = splitReviewReport(h3);
  assert.match(summary, /### 问题 1/);
  assert.match(summary, /烧录出旧字幕/);
  assert.match(detail, /^## 明细/);
}

// 空报告不该炸。
assert.deepEqual(splitReviewReport(""), { summary: "", detail: "" });

console.log("review report sections ok");
