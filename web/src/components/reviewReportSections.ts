// report.md 有两个读者，要的东西正交：验收的人要知道「能不能收、坏在哪」，照着修的
// agent 要基线 hash、命令输出、清场记录。历史上两者平铺在一份文档里，结果是人打开报告
// 先吃几十行合规证明——2026-09-26 抽查 `LqhF7g_rqANy` 第 1 轮那份，179 行里 11 个条目
// 分散在三套严重度刻度上，没有一句话回答「哪几条拦验收」。
//
// 所以拆：摘要段铺开给人看，其余收进开关。**盘上的 report.md 一个字都不动**，修复 agent
// 读的还是完整文件——这也是能在界面上敢折叠的前提。
//
// 这一份只回答两个问题，**都不从报告正文里猜意思**：
//
// ① **从哪一刀下手**——按报告自己的结构切（下面那三条规则），判据全是「解析树里这个块
//    是什么」，不是「这句话什么意思」。摘要自己太长时还有第二刀（`SUMMARY_ITEMS`）。
// ② **按钮能说什么**——只看 `conclusion` 这个权威字段。
//
// ② 是 2026-09-28 重做的，来由值得写下来。原先这里还挂着一套六百多行的判据，干的是
// 「从自由文本里猜作者到底有没有说可以验收」：整栏切段、白名单比对、删除线/问号/未完成
// 标点各一道闸……目的只有一个——决定折叠按钮敢不敢宣称「里面只有验证过程、证据、清场
// 记录」。十轮复审，每轮审查者花十分钟造一条新反例（`no fixed issues`、`可以验收？`、
// `_可以验收：_`、空链接、本地图片……），每轮补一条规则，文件从 320 行涨到 617 行又拆成
// 三个。方向每轮都对，但**反例空间无限、词表可枚举**，这个形状收敛不了。
//
// 真正的问题是层次放错了：这份代码住在一个通用 Markdown 渲染器里，手上只有一个
// `text: string`，除了猜字符串别无选择。可「这一轮到底通没通过」根本不需要猜——
// `free_review_rounds.conclusion` / `TaskReviewRound.conclusion` 里存着权威答案，界面上
// 那个红色「未通过」标签渲染的就是它。所以把它顺着传进来，那六百行整个删掉：
//
//   `verified`（权威结论说这一轮没有拦验收的问题）+ 切点落在报告自己声明的结论/发现节
//   之后 → 折叠里不可能藏着拦验收的问题，按钮敢写「展开技术明细」。
//   其余一切情况 → 按钮什么都不宣称（「展开完整报告」）。什么都不说的按钮撒不了谎，
//   于是再也造不出反例。
//
// 换完之后那句承诺**少说了很多，但不再撒谎**。全库 1057 份真实报告上跑新旧两版对比：
// 旧判据为 61 份挣到「展开技术明细（验证过程、证据、清场记录）」那句话，其中 **50 份的
// 权威结论是 `verify_failed`**——按钮正替一份「没通过」的报告宣称折叠里只有合规证明，而
// 那几条拦验收的问题完全可能就在折叠里。新规则下是 12 份，全部是 `verified`；反过来
// **没有一份 `verified` 的报告因此丢掉承诺**（旧版敢宣称、新版收回的：0 份）。删掉的六百
// 行判据，净效果就是把那 50 句谎话摘掉。
//
// 注意**这里不替报告的内容担保**：审查者要是把「必须修的问题」写满了却上报 `verified`，
// 那份报告本身就是坏的，红绿标签、验收流程全部跟着它错——那要在产出侧治（结论入口校验、
// 打回重写），不是渲染器能救的。产出侧现在只有一道闸：`server/src/free-workflow.ts` 的
// `reportFreeReviewConclusion` 要求报告非空。**「结论跟正文对不对得上」那道闸还没有做。**
// 这里用的是**系统本来就信的那个字段**，没有新增任何信任。
//
// 三条切点规则（都只问结构，认不出就不折）：
// - 首节标题是报告自己声明的判定/发现节（`## 结论` / `## Conclusion` / `## Verdict` /
//   `## 结论：verify_failed` / `## Findings` / `## 发现`）：整节留在首屏，从**第二个**
//   `##` 起折。折在第一个 `##` 之前会把判定一起折掉；只认中文「结论」那一个词时，222
//   行的英文报告和 323 份「发现」开场的报告都折不对。
// - 小节标题自己打头标了严重度（`## [中] …`）：开头连着的那几节问题全部留在首屏，从第
//   一个没标的 `##` 起折。
// - 其它形态：开头到**第一个** `##` 之前的引子留在首屏，其余全折。
// - 首屏凑不出读得懂的东西（开头只有标题、或者声明了结论节却没有第二个 `##`）就不拆：
//   一个标题加一个按钮的首屏，比多滚两屏更糟。**不拆不等于铺满**——`MarkdownBody.tsx`
//   会按渲染高度把它夹住，底下同样给一个什么都不宣称的按钮。拆点靠猜会把问题藏掉，按
//   高度夹不会：铺的是报告自己的开头，一个字没被重排。（真实形态
//   `_wWMPNIsrXF7/5XWkSb3U0UQK/round-1`：111 行，先写任务元数据和编译记录，
//   `## 2. 高优先级缺陷` 在第 24 行往后——按首节拆会把 P1～P3 全折掉。）
//
// 「哪个 `##` 是分界」交给解析器，不自己数字符。手写的行扫描器在这上面连错三轮，每轮都
// 是同一种形状——我们以为那行是标题，渲染器不这么认，于是拆点落在一段本不存在的边界上，
// 必须修的问题被折进折叠：
// ① 第 6 轮：代码示例里一行带说明文字的 ```，被当成闭合围栏，块里的 `##` 成了拆点；
// ② 第 7 轮：`<!-- ... -->` 里的 `##` 成了拆点，摘要断在一个孤零零的 `<!--` 上；
// ③ 同轮自查：列表项里缩进两格的 `##` 也成了拆点（第 6 轮补缩进容忍时带出来的）。
// 每修一个角就露出下一个角，因为判据本身是「我复刻的 CommonMark」而不是 CommonMark。
// 现在顶层二级标题由 `mdast-util-from-markdown`（`react-markdown` 渲染这份报告时用的就是
// 它）给出，围栏、HTML 块、列表、引用、缩进代码块一次性全部各归各位。
import type { ReviewConclusion } from "@ash/shared";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import { mentionsContractMarks, contractShape, problemStarts, type ParsedNode } from "./reviewReportFormat.ts";

/**
 * 一份报告切成的四段，**按源码先后排好、首尾相接、不重不漏**：
 * `summary` → `more` → `aside` → `detail`。合起来就是原文（切点上的空行被 `trimEnd()`
 * 吃掉，别的字节一个不动）。
 *
 * 中间两段只在「照格式写了、问题却超过 5 条」那一种形态下非空，其余时候一律是空串——
 * 那时 `summary` 里就含着第四栏，读的人只面对一个折叠。
 */
export type ReviewReportSections = {
  /** 铺开的那一半：报告自己的开头——结论节、标了严重度的那几节，或第一个 `##` 之前的引子。 */
  summary: string;
  /**
   * 摘要内部第二个折叠里的东西：第 6 条起的问题。为空表示摘要不分第二层。
   *
   * 这一段**是问题本身**，不是技术记录——按钮得照实写「展开其余 N 条问题」，别拿技术
   * 明细那句文案糊过去。
   */
  more: string;
  /** `more` 里有几条问题，也就是按钮上的 N。`more` 为空时是 0。 */
  rest: number;
  /**
   * 第四栏「不拦验收、但你该知道的」。只有在 `more` 非空时才单独拎出来——它得跨过中间
   * 那个折叠、继续留在首屏，否则一展开就轮到它被顶走。为空表示它在 `summary` 里。
   */
  aside: string;
  /** 收进开关的那一半；为空表示这篇没拆，别画展开按钮。 */
  detail: string;
  /**
   * **`detail` 那个折叠**里装的是什么——技术明细按钮的文案只能照它写。它不描述 `more`
   * 那一层：中间那层永远是问题，跟这里判到哪一档无关。
   *
   * - `"contract"`：权威结论是 `verified`，而且切点落在报告自己声明的结论/发现节之后。
   *   折叠里不可能有拦验收的问题，按钮可以写「展开技术明细（验证过程、证据、清场记录）」。
   * - `"lead"`：其余一切情况。折的是报告余下的全部内容，**问题可能就在里面**，所以一个
   *   字都不许替它宣称。
   * - `"whole"`：没拆，`detail` 为空。
   */
  kind: "whole" | "contract" | "lead";
};

/**
 * 摘要里最多铺开几条问题（`server/src/review-report-format.ts` 里写给审查者的也是这个数，
 * 用户需求原话「问题按用户会踩到的严重程度排，**最多 5 条**」）。
 *
 * 超出的部分不降档、也不截断：报告把 6 条全写在摘要里时**格式其实没错**——四栏齐全、
 * 每条三行俱全——错的只是它默认铺了满屏，用户要的「打开先看见结论」在第 6 条往后就没了。
 * 降档解决不了这个：降档换的是**技术明细按钮说什么**，铺开的那一段一个字都不会少。所以
 * 治的是铺开那一段，在摘要内部再折一层。（用户 2026-09-27 裁定，见 `5a34b180`。）
 */
const SUMMARY_ITEMS = 5;

/**
 * 首个 `##` 写成这样，就算**报告自己声明了「这一节是给人看的判定」**——整节留在首屏，
 * 从第二个 `##` 起才折。
 *
 * 收的是两种声明，因为读报告的人要的就是这两件事：判定（`结论` / `Conclusion` /
 * `Verdict`，后缀只容协议自己的判定词，`## 结论：verify_failed` 是真实形态）和发现
 * （`Findings` / `发现`）。全库 1055 份里 429 份的首节是这两类之一，尾部一水儿是验证
 * 记录、浏览器通道、清理——正是用户点名不想被糊一脸的东西。
 *
 * **全文相等**，不是「开头像」：`## 发现 1：数据会丢` 是一条问题本身，不是发现那一节；
 * `## 一、先说结论：核心功能是真的能用` 只讲了正面那半。认错的代价只是切点落偏，不会
 * 让按钮撒谎（那由 `conclusion` 管），但切偏了照样把该看的东西折走。
 */
const VERDICT_TITLES = /^(?:结论|Conclusion|Verdict)\s*(?:[：:]\s*(?:verified|verify_failed|blocked))?$|^(?:Findings?|发现)$/i;

/**
 * 小节标题自己**打头标了严重度**——`## [中] 筛选状态下点击…`、`## 【高】…`、`## [P1] …`。
 *
 * 这种标题不需要猜：报告自己说了这一节是一条问题，而且多严重。开头连着的这几节全部留在
 * 首屏，从第一个没标的 `##` 起才折（真实形态：`-MseXJQXVHVH` 的四轮报告，首节是问题、
 * 第二节就是「验证记录」，原先整篇铺开四五十行）。
 *
 * 只认**打头**，不认「标题里出现过」：`## 1. 【高】身份页高内容屏` 那种前面还有序号的
 * 不算——真实样本 `yz74LehaZzwl` 的首节是 `## 0. 先说结论之外的：这轮做对的部分`，它跟
 * 几条【高】是并列小节，从它折起才对。
 */
const SEVERITY_TITLES = /^[[【(（]\s*(?:P[0-3]|高|中|低|严重|阻断|Blocker|Critical|High|Medium|Low|Major|Minor)\s*[\]】)）]/i;

/** 节点的可见文字。核小标题写没写对用得上，别的地方别指望它排版。 */
function plainText(node: ParsedNode): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if ("children" in node) return node.children.map(plainText).join("");
  return "";
}

/**
 * 把报告切成「铺开的一半」和「收起的一半」。
 *
 * `conclusion` 是这一轮的**权威结论**（`free_review_rounds.conclusion` /
 * `TaskReviewRound.conclusion`），界面上那个红绿标签渲染的就是它。它只决定按钮敢不敢
 * 宣称折叠里是什么，不参与切点。拿不到（老数据、还没结论、或者打开的是一份孤立的报告
 * 文件）就传 `null`——按钮跟着什么都不说。
 */
export function splitReviewReport(text: string, conclusion: ReviewConclusion): ReviewReportSections {
  const whole: ReviewReportSections = {
    summary: text, more: "", rest: 0, aside: "", detail: "", kind: "whole",
  };
  // 解析器把孤立的 `\r` 也当换行，我们按 `\n` 切片——真碰上这种老式换行，行号就对不上了。
  // 对不上时一律整篇铺开：认不出只是啰嗦，按错的行号拆是把内容藏掉。
  if (/\r(?!\n)/.test(text)) return whole;

  const lines = text.split("\n");
  // 解析配置必须跟页面上那份一致（`MarkdownBody.tsx` 用 `remark-gfm`）。不一致的地方就是
  // 下一个洞：单列的 GFM 表格在核心语法眼里是普通段落，在页面上却是表格——我们据此拆，
  // 用户看到的却是另一回事。同一个道理已经让这份代码栽过一次（第 7 轮：手写扫描器跟
  // 渲染器对不上），这次直接把 GFM 扩展装上。
  const root = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  // 只认**顶层**的二级标题：列表项里、引用里、HTML 块里、围栏里的 `##` 都不是分界。
  const heads = root.children.filter(
    (node) => node.type === "heading" && node.depth === 2 && node.position,
  );
  const [head, next] = heads;
  if (!head?.position) return whole;
  const first = head.position.start.line - 1;

  /**
   * 按切点把原文分成首尾相接的几段。切点全部来自解析树里**顶层节点的起始行**，所以每一
   * 刀都落在两个块之间——不会切进围栏、列表项或表格内部。段与段之间只有切点上被
   * `trimEnd()` 吃掉的空白，其余字节原样。
   *
   * `claims` 说的是「这一刀切在报告自己声明的结论/发现节之后」。只有它和权威结论
   * `verified` **同时**成立，技术明细那个按钮才敢讲折叠里装着什么。
   *
   * `fold` 是摘要内部那第二层的两个切点（第 6 条的起始行、第四栏的起始行）。它**不看
   * 权威结论**：那一层的按钮照实写「展开其余 N 条问题」，名字就是内容，撒不了谎；而问题
   * 多到 6 条的报告几乎必然是没通过的那一批——跟着 `conclusion` 走等于把这一层关掉。
   */
  const cut = (
    at: number,
    claims: boolean,
    fold?: { more: number; aside: number; rest: number },
  ): ReviewReportSections => {
    const slice = (from: number, to?: number) => lines.slice(from, to).join("\n").trimEnd();
    const kind = claims && conclusion === "verified" ? "contract" as const : "lead" as const;
    if (!fold) return { summary: slice(0, at), more: "", rest: 0, aside: "", detail: slice(at), kind };
    return {
      summary: slice(0, fold.more),
      more: slice(fold.more, fold.aside),
      rest: fold.rest,
      aside: slice(fold.aside, at),
      detail: slice(at),
      kind,
    };
  };

  const title = plainText(head).trim();
  if (VERDICT_TITLES.test(title)) {
    // 没有第二个 `##` 时折掉的就是整个结论节，那还不如整篇铺开。
    if (!next?.position) return whole;
    const second = next.position.start.line - 1;
    // 这一节**提没提过栏目名**，决定了它是「旧格式」还是「新格式写坏了」——两者的安全
    // 方向正相反，判据见 `reviewReportFormat.ts`。提了却凑不齐四栏的，问题很可能就写在
    // 后面那个 `##` 里，从第二个 `##` 起折会连问题一起折掉，所以一律整篇铺开。
    const probes = lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
    const section = probes.slice(first, second).join("\n");
    if (!mentionsContractMarks(section)) return cut(second, false);
    const shape = contractShape(root, probes, first, second);
    if (!shape) return whole;
    // 照格式写了，但问题多到铺满一屏：前 5 条留在首屏，第 6 条起收进摘要内部那一层，
    // 第四栏跨过它继续留在首屏（否则一展开就轮到它被顶走）。
    const items = problemStarts(root, shape);
    const sixth = items[SUMMARY_ITEMS];
    const aside = shape.columns[3];
    if (sixth === undefined || !aside) return cut(second, true);
    return cut(second, true, { more: sixth, aside: aside.at, rest: items.length - SUMMARY_ITEMS });
  }

  // 报告自己标了严重度：所有标了的小节都留在首屏，折的是它们后面的验证记录和清场。
  const tail = heads.findIndex((node) => !SEVERITY_TITLES.test(plainText(node).trim()));
  const fold = tail > 0 ? heads[tail]?.position : undefined;
  if (SEVERITY_TITLES.test(title) && fold) return cut(fold.start.line - 1, false);

  /**
   * 通用形态：引子铺开，第一个 `##` 起收进折叠。
   *
   * 「有没有引子」按解析树问，不数行：标题之外还得有**读得出字**的顶层内容。只有一行
   * `# 报告` 的开头不算，只有一条水平线、一段 HTML 注释或一张图的开头也不算——那样首屏
   * 就是「一个标题 + 一坨看不懂的东西 + 一个按钮」，比多滚两屏更糟。
   */
  const told = root.children.some(
    (node) =>
      node.type !== "heading" && node.position
      && node.position.start.line - 1 < first
      && plainText(node).trim() !== "",
  );
  return told ? cut(first, false) : whole;
}
