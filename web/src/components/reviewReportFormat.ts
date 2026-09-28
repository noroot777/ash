// 一份报告**是不是照 ash 自己那套格式写的**——纯结构签名，不判断任何一句话的意思。
//
// 只回答一件事：`## 结论` 那一节里，四个固定栏目在不在、是不是四段独立的、按不按序。
// 用处只有一个——决定 `reviewReportSections.ts` 敢不敢按「结论 / 技术明细」两段切：
//
// - 一个栏目名都没提过 = 旧格式的结论节，判定写在这一节里，从第二个 `##` 起折才对
//   （全库 164 份首个 `##` 是「结论」的报告，146 份是这个样子）。
// - 提过、而且四栏齐全按序 = 照格式写的，两段切点就是报告自己的结构。
// - 提过、却凑不齐 = **有人在照新格式写、只是没写对**。这类报告的问题本来就该写在结论
//   节里，从第二个 `##` 起折会连问题一起折掉（第 2 轮把第三栏写成 `## 必须修的问题`、
//   第 10 轮把那条问题写成 `##`，都是这个形状）。一律整篇铺开。
//
// 判「提过没有」而不是直接验签名，是因为差的那一档正好是危险的那一档：「我按模板核对了
// 能不能验收、现在什么能用了……」这种正文提及凑不出签名，却足以说明后面那个 `##` 可能就是
// 问题小节。认错方向的代价不对称，宁可多铺开 18 份。
//
// **这里不判断报告说了什么。**「能不能验收」那一栏写的是通过还是不通过，由
// `free_review_rounds.conclusion` 那个权威字段回答，不从正文里猜——那套猜法（整栏切段、
// 白名单比对、删除线/问号/未完成标点各一道闸）在十轮复审里被逐条攻破，已于 2026-09-28
// 整体退役，来由写在 `reviewReportSections.ts` 头上。这一份剩下的全是「解析树里这个块是
// 什么」，十轮里一次都没被攻破过。
import type { fromMarkdown } from "mdast-util-from-markdown";

export type Parsed = ReturnType<typeof fromMarkdown>;
export type ParsedNode = Parsed | Parsed["children"][number];

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
 * 把「拿不准就降到第二档」换成了猜，而猜错的代价不对称：降级最多让人多点一下按钮，
 * 误判成契约是让那个按钮替报告宣称「里面只有验证过程、证据、清场记录」。
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
export const CONTRACT_MARKS = ["能不能验收", "现在什么能用了", "必须修的问题", "不拦验收[、,]?但你该知道的"];
/**
 * `**标签**` + 冒号/行尾，或 `**标签：**` + 随便。
 *
 * 两个分支对应上面说的两种写法：冒号在加粗外面时，它（或行尾）就是标签结束的证据；
 * 冒号在加粗里面时，紧跟在标签后的那个冒号本身就是证据，后面写什么都行。
 *
 * 缩进写 ` {0,3}` 不写 `\s{0,3}`：制表符按 4 列算，那已经是缩进代码块了。
 */
export const MARK_LINES = CONTRACT_MARKS.map(
  (mark) => new RegExp(
    `^ {0,3}(?:[-*+]\\s+|\\d+[.)]\\s+)?\\*\\*\\s*${mark}\\s*(?:\\*\\*\\s*(?:[：:].*)?$|[：:]\\s*\\*\\*)`,
  ),
);

/**
 * 摘要那一节里，够得上「一个栏目」的节点起始行——按源码先后排好。
 *
 * 允许的形态只有两种：第一、第二个顶层 `##` 之间的**顶层段落**，以及顶层列表**直属**
 * 列表项里的段落。嵌套一层的列表项不算——「上一轮报告的结论：」底下缩一格抄四行，跟块
 * 引用是同一种伪造。
 *
 * 只收**起始行**，不收节点覆盖的每一行，这是第 9 轮补的一刀。收整段时，一个普通说明段
 * 里顺手抄四行旧结论就能凑齐签名（「下面抄的是上一轮结论，不是本轮：」后面跟四行），
 * 那一份真正的问题于是被折进明细。栏目是**独立的一段**，不是「某段里出现过这四个词」。
 *
 * 这份名单的形状变过两次，方向都一样。最早是黑名单（排除代码块和 HTML 块、剩下的都
 * 算），漏了块引用——CommonMark 允许引用段落的后续行省掉 `>`，源码看着顶格、解析树里
 * 整段在 `blockquote` 里。黑名单永远缺一条，所以换成白名单：漏掉一种合法写法只是不拆
 * （啰嗦），多算一种容器是把发现藏掉。
 */
export function markCandidateStarts(root: Parsed, after: number, before: number): number[] {
  const starts: number[] = [];
  const take = (node: ParsedNode) => {
    const at = node.position ? node.position.start.line - 1 : -1;
    if (at > after && at < before) starts.push(at);
  };
  for (const node of root.children) {
    if (node.type === "paragraph") take(node);
    else if (node.type === "list") {
      for (const item of node.children) {
        for (const child of item.children) if (child.type === "paragraph") take(child);
      }
    }
  }
  return starts.sort((a, b) => a - b);
}

/** 节点的可见文字。核小标题写没写对用得上，别的地方别指望它排版。 */
export function plainText(node: ParsedNode): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if ("children" in node) return node.children.map(plainText).join("");
  return "";
}

/** 一个栏目候选：它那一段/那个小标题的起始行，加上命中的是第几栏。 */
export type Column = { at: number; column: number };

/**
 * 四栏写成 `###` 小标题的那种写法（真实形态：`MiBg8G40scWo` 的两轮、`ANhYpXO-L1ic`，
 * 以及本任务 `dB45LYOzuxnx/round-2`）。
 *
 * 判据是标题的可见文字**精确等于**栏目名（容一个结尾冒号）。这跟被抓过三次的那种放宽
 * 不是一回事：那几次危险都来自**前缀**匹配（`**能不能验收不了**`、`**能不能验收**不
 * 了解的人先看这里`），续写能混进来；这里是整段标题的全文相等，混不进东西。
 */
export function headingColumns(root: Parsed, after: number, before: number): Column[] {
  const columns: Column[] = [];
  for (const node of root.children) {
    if (node.type !== "heading" || node.depth !== 3 || !node.position) continue;
    const at = node.position.start.line - 1;
    if (at <= after || at >= before) continue;
    const text = plainText(node).trim();
    const column = CONTRACT_MARKS.findIndex((mark) => new RegExp(`^${mark}[：:]?$`).test(text));
    if (column >= 0) columns.push({ at, column });
  }
  return columns;
}

/**
 * 这一节**照格式写了四栏**：四个栏目齐全、按序、不重样。
 *
 * 「按序、不重样」是第 9 轮补的：只问「这四个标签各自出现过没有」时，四栏完全倒着写也
 * 算数——那更像是抄了一份别人的结论。
 *
 * 两种写法都认：prompt 给的加粗标签段落，以及把同样四个栏目写成 `###` 小标题。后者是真实
 * 存在的形态——全库 1036 份里 4 份长这样。
 */
export function usesContractFormat(root: Parsed, probes: string[], first: number, second: number): boolean {
  const bold = markCandidateStarts(root, first, second)
    .map((at) => ({ at, column: MARK_LINES.findIndex((pattern) => pattern.test(probes[at])) }))
    .filter((hit) => hit.column >= 0);
  const complete = (columns: Column[]) =>
    columns.length === MARK_LINES.length && columns.every((hit, order) => hit.column === order);
  return complete(bold) || complete(headingColumns(root, first, second));
}

/** 这一节**提过**栏目名——哪怕只是正文里顺口提了一句。 */
export function mentionsContractMarks(section: string): boolean {
  return CONTRACT_MARKS.some((mark) => new RegExp(mark).test(section));
}
