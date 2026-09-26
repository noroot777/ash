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
//
// 「哪个 `##` 是分界」交给解析器，不自己数字符。手写的行扫描器在这上面连错三轮，每轮都
// 是同一种形状——我们以为那行是标题，渲染器不这么认，于是拆点落在一段本不存在的边界上，
// 必须修的问题被折进「展开技术明细」：
// ① 第 6 轮：代码示例里一行带说明文字的 ```，被当成闭合围栏，块里的 `##` 成了拆点；
// ② 第 7 轮：`<!-- ... -->` 里的 `##` 成了拆点，摘要断在一个孤零零的 `<!--` 上；
// ③ 同轮自查：列表项里缩进两格的 `##` 也成了拆点（第 6 轮补缩进容忍时带出来的）。
// 每修一个角就露出下一个角，因为判据本身是「我复刻的 CommonMark」而不是 CommonMark。
// 现在顶层二级标题由 `mdast-util-from-markdown`（`react-markdown` 渲染这份报告时用的就是
// 它）给出，围栏、HTML 块、列表、引用、缩进代码块一次性全部各归各位。
import { fromMarkdown } from "mdast-util-from-markdown";

export type ReviewReportSections = {
  /** 从开头到技术明细之前：一级标题 + 摘要那一节。不合契约时是整篇。 */
  summary: string;
  /** 第二个 `##` 起的技术明细；为空表示这篇没拆，别画展开按钮。 */
  detail: string;
};

type Parsed = ReturnType<typeof fromMarkdown>;
type ParsedNode = Parsed | Parsed["children"][number];

/**
 * 新契约那一节的四个固定小标题（`server/src/review-report-format.ts` 要求原样写出）。
 *
 * 判据用它们而不是标题措辞，是因为**标题证明不了这是一份按契约写的报告**：
 * 「0. 先说结论之外的：这轮做对的部分」和「一、先说结论：核心功能是真的能用」都含
 * 「结论」二字，前者意思还正相反；按标题拆，这两份报告的【高】/高危发现会整批落进
 * 一个写着「验证过程、证据、清场记录」的折叠里——用户看到的首屏只剩「做对的部分」。
 * （真实样本：`yz74LehaZzwl/H1MQnmqKzCSl/round-1`、`KyF5hukfZ5D9/RJPSXRqyJIo2/round-1`）
 *
 * **四个一个都不能少，而且必须是加粗标签行。**曾经只要求任意命中两个子串，结果半套
 * 摘要照样被拆：审查者把第三栏误写成 `## 必须修的问题`，前两栏就凑够了两个标记，拆点
 * 正好落在那个标题上——首屏写着「有 1 条必须先修」，那一条却在折叠里。放宽一档就等于
 * 把「认不出就整篇铺开」这条保证换成了猜，而猜错的方向恰好是藏发现。
 *
 * 加粗行这一条同时挡掉「正文、引文或代码块里顺口提到两个栏目名」：契约要的是那四段
 * 结构真的在，不是那几个词出现过。
 *
 * **标签要完整闭合、后面还得断干净。**只锚定行首和栏目文字时，`**能不能验收不了**`
 * 这类「把续写塞进加粗里」的相近措辞能凑齐签名；只要求闭合 `**` 时，把同样的话挪到
 * 加粗外面（`**能不能验收**不了解的人先看这里`）又能凑齐一次。同一个判据被放宽过三次，
 * 后果每次一样：首屏写着有问题，问题本身在折叠里。所以现在要求闭合之后**只能是冒号、
 * 空白或行尾**，第四栏也写全「但你该知道的」而不是缩写。
 *
 * 容忍的只有两种真实写法：加粗把冒号包进去（`**能不能验收：**不能`），以及第四栏的
 * 顿号写不写。
 */
/** 四个固定小标题的**正则片段**（不是纯文本）：第四栏容忍顿号写不写。 */
const CONTRACT_MARKS = ["能不能验收", "现在什么能用了", "必须修的问题", "不拦验收[、,]?但你该知道的"];
/**
 * `**标签**` + 冒号/行尾，或 `**标签：**` + 随便。
 *
 * 两个分支对应上面说的两种写法：冒号在加粗外面时，它（或行尾）就是标签结束的证据；
 * 冒号在加粗里面时，紧跟在标签后的那个冒号本身就是证据，后面写什么都行。
 *
 * 缩进写 ` {0,3}` 不写 `\s{0,3}`：制表符按 4 列算，那已经是缩进代码块了。
 */
const MARK_LINES = CONTRACT_MARKS.map(
  (mark) => new RegExp(
    `^ {0,3}(?:[-*+]\\s+|\\d+[.)]\\s+)?\\*\\*\\s*${mark}\\s*(?:\\*\\*\\s*(?:[：:].*)?$|[：:]\\s*\\*\\*)`,
  ),
);

/**
 * 代码块和 HTML 块占掉的行号。
 *
 * 契约标记仍按源码逐行认——那四行的措辞判据是一轮轮反例攒出来的，跟怎么解析无关——但
 * 认之前要先把这些行摘掉：贴一份别人的报告当证据，或者在注释里留一段模板，都不能把自己
 * 变成契约报告。
 */
function inertLines(root: Parsed): Set<number> {
  const inert = new Set<number>();
  const walk = (node: ParsedNode) => {
    if ((node.type === "code" || node.type === "html") && node.position) {
      for (let at = node.position.start.line - 1; at < node.position.end.line; at += 1) inert.add(at);
    }
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(root);
  return inert;
}

export function splitReviewReport(text: string): ReviewReportSections {
  // 解析器把孤立的 `\r` 也当换行，我们按 `\n` 切片——真碰上这种老式换行，行号就对不上了。
  // 对不上时一律整篇铺开：认不出只是啰嗦，按错的行号拆是把内容藏掉。
  if (/\r(?!\n)/.test(text)) return { summary: text, detail: "" };

  const lines = text.split("\n");
  const root = fromMarkdown(text);
  // 只认**顶层**的二级标题：列表项里、引用里、HTML 块里、围栏里的 `##` 都不是分界。
  const heads: number[] = [];
  for (const node of root.children) {
    if (node.type === "heading" && node.depth === 2 && node.position) {
      heads.push(node.position.start.line - 1);
    }
  }
  const [first, second] = heads;
  if (first === undefined || second === undefined) return { summary: text, detail: "" };

  // 匹配用的是去掉行尾 `\r` 的副本，切片仍用原始行——这样 CRLF 报告认得出，返回的正文
  // 又跟入参逐字节一致（不悄悄替换用户的换行）。踩过的坑在正则语义：`\r` 是行终结符，
  // `.` 不匹配它、不带 `m` 的 `$` 只认串尾，于是 `**能不能验收**：不能\r` 认不出来。
  const probes = lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const inert = inertLines(root);
  // 只有**证明得了自己按新契约写**的报告才拆：四个加粗标签行全都落在第一节里。存量报告
  // 一律整篇铺开——拆点是第二个 `##`，而它们的发现常常就在那之后（`LqhF7g_rqANy` 的缺陷
  // 在第三个 `##`、`zs6JLcw1VAdr` 的全部发现在第一个 `##`）。把发现藏起来比让人多滚两屏
  // 严重得多，这一档不留猜的余地：认不出只是啰嗦，认错了是骗人。
  const complete = MARK_LINES.every((pattern) =>
    probes.some((line, at) => at > first && at < second && !inert.has(at) && pattern.test(line)),
  );
  if (!complete) return { summary: text, detail: "" };
  return {
    summary: lines.slice(0, second).join("\n").trimEnd(),
    detail: lines.slice(second).join("\n").trimEnd(),
  };
}
