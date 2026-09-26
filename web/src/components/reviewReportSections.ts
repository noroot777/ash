// report.md 有两个读者，要的东西正交：验收的人要知道「能不能收、坏在哪」，照着修的
// agent 要基线 hash、命令输出、清场记录。历史上两者平铺在一份文档里，结果是人打开报告
// 先吃几十行合规证明——2026-09-26 抽查 `LqhF7g_rqANy` 第 1 轮那份，179 行里 11 个条目
// 分散在三套严重度刻度上，没有一句话回答「哪几条拦验收」。
//
// 所以拆：摘要段铺开给人看，其余收进开关。**盘上的 report.md 一个字都不动**，修复 agent
// 读的还是完整文件——这也是能在界面上敢折叠的前提。
//
// 契约（`server/src/review-prompts.ts` 的 `verifyRules` 负责让审查者照着写）：
// 报告的第一个二级标题是 `## 结论`，那一节就是写给人看的摘要，下一个 `##` 起是技术明细。
// 对不上就整篇铺开——存量报告没有这个约定，宁可啰嗦也不能把内容藏掉。

export type ReviewReportSections = {
  /** 从开头到技术明细之前：一级标题 + `## 结论` 那一节。不合契约时是整篇。 */
  summary: string;
  /** 第二个 `##` 起的技术明细；为空表示这篇没拆，别画展开按钮。 */
  detail: string;
};

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
/** 正好两个 `#`：`###` 是小节内部结构，不构成明细分界。 */
const H2 = /^##\s+(.*)$/;

export function splitReviewReport(text: string): ReviewReportSections {
  const lines = text.split("\n");
  const heads: { at: number; title: string }[] = [];
  // 围栏里的 `## xxx` 是被审代码或命令输出的一部分，不是小节标题。开闭用同种记号配对，
  // 这样 ``` 块里贴的 ~~~ 不会把围栏提前关掉。
  let fence: string | null = null;
  for (const [at, line] of lines.entries()) {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    const title = H2.exec(line)?.[1];
    if (title !== undefined) heads.push({ at, title: title.trim() });
  }

  const [first, second] = heads;
  // 判据是「第一个二级标题**是不是在讲结论**」，不是标题长什么样：`## 结论`、
  // `## 结论：不能验收`、`## 给人看的结论`、`## 范围与审查结论` 都算。审查者把标题写歪
  // 一个字就整篇铺开，那第二层就白做了。
  //
  // 但**不含「结论」就坚决不拆**，哪怕因此啰嗦：拆点是第二个 `##`，一律拆会把第一节之后
  // 的东西全收进折叠，而存量报告的发现常常就在那儿——`LqhF7g_rqANy` 的缺陷在「三、发现的
  // 缺陷」（第三个 `##`）、`zs6JLcw1VAdr` 的全部发现在「Finding」（第一个 `##`）。
  // 把发现藏起来比让人多滚两屏严重得多，所以这一档只做保守放宽。
  if (!first || !second || !first.title.includes("结论")) return { summary: text, detail: "" };
  return {
    summary: lines.slice(0, second.at).join("\n").trimEnd(),
    detail: lines.slice(second.at).join("\n").trimEnd(),
  };
}
