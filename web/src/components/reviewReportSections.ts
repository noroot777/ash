// report.md 有两个读者，要的东西正交：验收的人要知道「能不能收、坏在哪」，照着修的
// agent 要基线 hash、命令输出、清场记录。历史上两者平铺在一份文档里，结果是人打开报告
// 先吃几十行合规证明——2026-09-26 抽查 `LqhF7g_rqANy` 第 1 轮那份，179 行里 11 个条目
// 分散在三套严重度刻度上，没有一句话回答「哪几条拦验收」。
//
// 所以拆：摘要段铺开给人看，其余收进开关。**盘上的 report.md 一个字都不动**，修复 agent
// 读的还是完整文件——这也是能在界面上敢折叠的前提。
//
// 契约（`server/src/review-report-format.ts` 负责让审查者照着写）：报告的第一个二级小节
// 是写给人看的摘要，里面有「能不能验收 / 现在什么能用了 / 必须修的问题 / 不拦验收但你该
// 知道的」四个固定小标题，下一个 `##` 起是技术明细。**认不出这四段结构就整篇铺开**——
// 存量报告没有这个约定，宁可啰嗦也不能把内容藏掉。

export type ReviewReportSections = {
  /** 从开头到技术明细之前：一级标题 + 摘要那一节。不合契约时是整篇。 */
  summary: string;
  /** 第二个 `##` 起的技术明细；为空表示这篇没拆，别画展开按钮。 */
  detail: string;
};

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
/** 正好两个 `#`：`###` 是小节内部结构，不构成明细分界。 */
const H2 = /^##\s+(.*)$/;

/**
 * 新契约那一节的四个固定小标题（`server/src/review-report-format.ts` 要求原样写出）。
 *
 * 判据用它们而不是标题措辞，是因为**标题证明不了这是一份按契约写的报告**：
 * 「0. 先说结论之外的：这轮做对的部分」和「一、先说结论：核心功能是真的能用」都含
 * 「结论」二字，前者意思还正相反；按标题拆，这两份报告的【高】/高危发现会整批落进
 * 一个写着「验证过程、证据、清场记录」的折叠里——用户看到的首屏只剩「做对的部分」。
 * （真实样本：`yz74LehaZzwl/H1MQnmqKzCSl/round-1`、`KyF5hukfZ5D9/RJPSXRqyJIo2/round-1`）
 *
 * 要两个而不是一个：一句话里偶然出现某个词不算数，四段结构同时出现才是签名。
 */
const CONTRACT_MARKS = ["能不能验收", "现在什么能用了", "必须修的问题", "不拦验收"];
const MARKS_REQUIRED = 2;

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
  if (!first || !second) return { summary: text, detail: "" };
  // 只有**证明得了自己按新契约写**的报告才拆。存量报告一律整篇铺开：拆点是第二个 `##`，
  // 而它们的发现常常就在那之后——`LqhF7g_rqANy` 的缺陷在第三个 `##`、`zs6JLcw1VAdr`
  // 的全部发现在第一个 `##`。把发现藏起来比让人多滚两屏严重得多，这一档不留猜的余地。
  const firstSection = lines.slice(first.at, second.at).join("\n");
  const marks = CONTRACT_MARKS.filter((mark) => firstSection.includes(mark)).length;
  if (marks < MARKS_REQUIRED) return { summary: text, detail: "" };
  return {
    summary: lines.slice(0, second.at).join("\n").trimEnd(),
    detail: lines.slice(second.at).join("\n").trimEnd(),
  };
}
