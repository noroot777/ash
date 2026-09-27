// report.md 有两个读者，要的东西正交：验收的人要知道「能不能收、坏在哪」，照着修的
// agent 要基线 hash、命令输出、清场记录。历史上两者平铺在一份文档里，结果是人打开报告
// 先吃几十行合规证明——2026-09-26 抽查 `LqhF7g_rqANy` 第 1 轮那份，179 行里 11 个条目
// 分散在三套严重度刻度上，没有一句话回答「哪几条拦验收」。
//
// 所以拆：摘要段铺开给人看，其余收进开关。**盘上的 report.md 一个字都不动**，修复 agent
// 读的还是完整文件——这也是能在界面上敢折叠的前提。
//
// 折叠分**两档**，按「这份报告能证明什么」给：
//
// ① 按契约拆（`server/src/review-report-format.ts` 负责让审查者照着写）：报告的第一个
//    二级小节是写给人看的摘要，里面有「能不能验收 / 现在什么能用了 / 必须修的问题 /
//    不拦验收但你该知道的」四个固定小标题，下一个 `##` 起是技术明细。这一档能担保折叠
//    里只有技术记录，所以按钮敢写「展开技术明细（验证过程、证据、清场记录）」。
//    **担保的是「折叠里没有问题」，不是「摘要够短」**——四栏齐全、每条问题写全三行、条数
//    对得上，折叠里就只剩技术记录，这句话跟摘要里写了几条无关。
//
//    所以摘要够不够短是**另一件事**，得另外解决：契约给的是「最多 5 条」（用户需求原话
//    「问题按用户会踩到的严重程度排，最多 5 条」），可报告把 6 条、20 条全写在摘要里时，
//    格式其实没错——四栏齐全、每条三行俱全，错的只是它默认铺了满屏，用户要的「打开先看见
//    结论」在第 6 条往后就没了。降档解决不了这个：降档换的是**技术明细按钮说什么**，铺开
//    的那一段一个字都不会少。所以这种报告留在契约档，**摘要内部再折一层**——前 5 条铺开，
//    第 6 条起收进照实写着「展开其余 N 条问题」的按钮，第四栏跨过这一层继续留在首屏。
//    两个折叠各管各的：里面那个装问题，外面那个装技术记录，谁也不替谁背书。
// ② 认不出契约（存量报告、某轮审查者没照 prompt 写），**或者报告自己把一部分问题放进了
//    折叠**，就降一档：铺开的那一段留在首屏，余下全部收进一个不作任何承诺的「展开完整
//    报告」。这是用户点名要的结构保证——「就算某轮审查者没照 prompt 写，你也不会被 46 行
//    合规证明糊一脸」。折在哪看报告自己怎么写：
//    - 首节标题就是「这是给人看的判定」的声明（`## 结论` / `## Conclusion` / `## Verdict` /
//      `## 结论：verify_failed` / `## Findings` / `## 发现`）：整节留在首屏，从**第二个**
//      `##` 起折。折在第一个 `##` 之前会把判定一起折掉；只认中文「结论」那一个词时，222
//      行的英文报告和 323 份「发现」开场的报告都折不对。
//    - 四栏齐全、但走了契约自己那条「摘要最多展开 5 条，其余在第 5 条后面列标题、完整三行
//      写进明细」的路：格式完全合规，可折叠里**确实躺着第 6 条往后的问题**，所以按钮必须
//      收回那句承诺。拆点不变（第二个 `##`），换的只是按钮说什么。
//    - 小节标题自己标了严重度（`## [中] …`）：开头连着的那几节问题全部留在首屏，从第一个
//      没标的 `##` 起折。
//    - 其它形态：开头到**第一个** `##` 之前的引子留在首屏。
// ③ 首屏凑不出读得懂的东西（开头只有标题、首节又不是报告自己声明的结论节，或者声明了
//    却没有第二个 `##`）就不拆：一个标题加一个按钮的首屏，比多滚两屏更糟。**这一档不拆
//    不等于铺满**——`MarkdownBody.tsx` 会按渲染高度把它夹住，底下同样给一个什么都不宣称
//    的「展开完整报告」。拆点靠猜会把问题藏掉，按高度夹不会：铺的是报告自己的开头，一个
//    字没被重排。（真实形态 `_wWMPNIsrXF7/5XWkSb3U0UQK/round-1`：111 行，先写任务元数据
//    和编译记录，`## 2. 高优先级缺陷` 在第 24 行往后——按首节拆会把 P1～P3 全折掉。）
//
// 第二档为什么安全，而「按标题猜出摘要在哪」不安全：差别不在折不折，在**折掉的是什么**
// 和**按钮说了什么**。按标题猜那一版把「## 0. 先说结论之外的：这轮做对的部分」当成摘要，
// 拆在它后面，两条【高】落进一个写着「验证过程、证据、清场记录」的折叠——首屏只剩「做对
// 的部分」，按钮还在替它背书。降级这一档反过来：折的起点由「报告自己把判定写在哪」决定
// （抽查的 7 份存量报告把 `结论：verify_failed —— N 个可复现缺陷` 写在第一个 `##` 之前，
// 另外 21 份写在 `## 结论` 那一节里），按钮则什么都不宣称。
//
// 「新格式写坏了」不走第二档，一律整篇铺开：结论节里提过栏目名、却凑不齐四段、不按序，
// 或者证明不了问题在摘要里——这类报告的问题**本来就该写在结论节里**，从第二个 `##` 起折
// 会连问题一起折掉（第 2 轮把第三栏写成 `## 必须修的问题`、第 10 轮把那条问题写成 `##`）。
// 不按长度设阈值：结构保证一旦变成「短的时候不保证」，就又会在某一份报告上糊人一脸。
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
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/**
 * 一份报告切成的四段，**按源码先后排好、首尾相接、不重不漏**：
 * `summary` → `more` → `aside` → `detail`。合起来就是原文（切点上的空行被
 * `trimEnd()` 吃掉，别的字节一个不动）。
 *
 * 中间两段只在契约档的「问题超过 5 条」那一种形态下非空，其余时候一律是空串——
 * 那时 `summary` 里就含着第四栏，读的人只面对一个折叠。
 */
export type ReviewReportSections = {
  /** 铺开的那一半：按契约拆时是「一级标题 + 摘要那一节」，降级时是第一个 `##` 之前的引子。 */
  summary: string;
  /**
   * 摘要内部第二个折叠里的东西：第 6 条起的问题。为空表示摘要不分第二层。
   *
   * 这一段**是问题本身**，不是技术记录——按钮得照实写「展开其余 N 条问题」，别拿
   * 技术明细那句文案糊过去。
   */
  more: string;
  /** `more` 里有几条问题，也就是按钮上的 N。`more` 为空时是 0。 */
  rest: number;
  /**
   * 第四栏「不拦验收、但你该知道的」。只有在 `more` 非空时才单独拎出来——它得跨过
   * 中间那个折叠、继续留在首屏，否则一展开就轮到它被顶走。为空表示它在 `summary` 里。
   */
  aside: string;
  /** 收进开关的那一半；为空表示这篇没拆，别画展开按钮。 */
  detail: string;
  /**
   * **`detail` 那个折叠**里装的是什么——技术明细按钮的文案只能照它写。它不描述 `more`
   * 那一层：中间那层永远是问题，跟这里判到哪一档无关。
   *
   * - `"whole"`：没拆，`detail` 为空。
   * - `"contract"`：按新契约拆的，折叠里只有技术记录，可以这么写在按钮上。
   * - `"lead"`：存量报告的粗拆，折叠里是报告余下的**全部**内容，**可能包含问题本身**，
   *   所以按钮不准替它宣称里面是什么。
   */
  kind: "whole" | "contract" | "lead";
};

/**
 * `provesContract` 的结论：判到哪一档，以及摘要要不要再分一层。
 *
 * `fold` 只在契约档给：四栏齐全、每条问题写全三行、条数也对得上，**但条目多到摘要
 * 一屏放不下**。这时折叠里确实只有技术记录（契约档的担保没变），铺开的那一段却重新
 * 变成一堵问题墙——用户要的「打开先看见结论」在第 6 条往后就失效了。所以摘要自己
 * 再分一层，前 5 条铺开，其余收进一个照实说话的按钮。
 */
type Proof = {
  kind: "contract" | "lead";
  /** 摘要内部的两个切点（第 6 条的起始行、第四栏的起始行），加上按钮上的 N。 */
  fold?: { more: number; aside: number; rest: number };
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
 * 首个 `##` 写成这样，就算**报告自己声明了「这一节是给人看的判定」**——整节留在首屏，
 * 从第二个 `##` 起才折。
 *
 * 收的是两种声明，因为读报告的人要的就是这两件事：判定（`结论` / `Conclusion` /
 * `Verdict`，后缀只容协议自己的判定词，`## 结论：verify_failed` 是真实形态）和发现
 * （`Findings` / `发现`）。全库 323 份报告的首节是后者，尾部一水儿是验证记录、浏览器
 * 通道、清理——正是用户点名不想被糊一脸的东西。
 *
 * **全文相等**，不是「开头像」：`## 发现 1：数据会丢` 是一条问题本身，不是发现那一节；
 * `## 一、先说结论：核心功能是真的能用` 只讲了正面那半。放宽到前缀的代价见
 * `splitReviewReport` 里那段注释。
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
function markCandidateStarts(root: Parsed, after: number, before: number): number[] {
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
function plainText(node: ParsedNode): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if ("children" in node) return node.children.map(plainText).join("");
  return "";
}

/** 一个栏目候选：它那一段/那个小标题的起始行，加上命中的是第几栏。 */
type Column = { at: number; column: number };

/**
 * 四栏写成 `###` 小标题的那种写法（真实形态：`MiBg8G40scWo` 的两轮、`ANhYpXO-L1ic`，
 * 以及本任务 `dB45LYOzuxnx/round-2`）。
 *
 * 判据是标题的可见文字**精确等于**栏目名（容一个结尾冒号）。这跟被抓过三次的那种放宽
 * 不是一回事：那几次危险都来自**前缀**匹配（`**能不能验收不了**`、`**能不能验收**不
 * 了解的人先看这里`），续写能混进来；这里是整段标题的全文相等，混不进东西。
 */
function headingColumns(root: Parsed, after: number, before: number): Column[] {
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
 * 这组栏目候选够不够格判成契约。两件事都得成立：
 *
 * ① **四个独立栏目、齐全、按序、不重样。**「按序、不重样」是第 9 轮补的：只问「这四个
 *    标签各自出现过没有」时，四栏完全倒着写也算数——那更像是抄了一份别人的结论。
 * ② **问题本身证明得了在摘要里**，不能只凭标签就假定第二个 `##` 之后都是技术记录。第
 *    10 轮的反例：摘要写着「不能 —— 有 1 条必须先修」「必须修的问题：见下方」，那一条
 *    却写成了下一个 `##`，于是首屏只剩「见下方」。判据照契约本身来
 *    （`server/src/review-report-format.ts`）：要么每条问题一个小标题**并带着那固定三行**，
 *    要么只写「没有发现问题」六个字。
 *
 * ② 验的是**全部条目**，不是「有一条就行」。第 6 轮的反例：摘要写着「有 2 条必须先修」，
 * 第一条按契约写全，第二条却写成了下一个 `##`——只要一条过关就放行时，那第二条连同按钮
 * 上的「验证过程、证据、清场记录」一起把人骗了。所以两道都验：
 *
 * - 问题栏里**每一个**小标题都得是一条按契约写的问题（契约原话：「不许把一条塞进另一条
 *   的正文里，扫标题要能数清楚一共几条」——说明性小标题混在里面就数不清了）；
 * - 「能不能验收」里**必须报出条数**，而且对得上摘要里的条目数。第 7 轮的反例是同一形状
 *   的最后一个口子：不报数时曾经直接放行，于是「不能，请修完再验」加一条合规问题就够，
 *   真正的第二条写在下一个 `##` 里照样被折走。数不出来就证明不了摘要是全的。
 * - **「没有发现问题」那条岔路也得对数。**第 8 轮的反例：「不能 —— 有 2 条必须先修」配上
 *   问题栏只写「没有发现问题」，零条目分支曾经直接返回、把条数校验整个跳过去，两条真问题
 *   写在下一个 `##` 里，首屏于是同时显示「有 2 条必须先修」和「没有发现问题」。报告自相
 *   矛盾时不许挑对自己有利的那一半读。
 *
 * 返回的是**哪一档**，不是「行不行」——因为契约本身允许一种「问题就在折叠里」的写法：摘要
 * 最多展开 5 条，更多的在第 5 条后面写一行「其余 N 条：…」，完整三行放进明细。那种报告
 * 格式完全合规，但折叠里**确实有问题**，所以它不能走契约档——按钮会替它宣称「里面只有
 * 验证过程、证据、清场记录」。这类报告降到 `lead`：照样从第二个 `##` 起折（5 条问题和那
 * 行分流声明全留在首屏），按钮换成什么都不宣称的「展开完整报告」。第 8 轮抓到的
 * 「其余 3 条：详见明细」正是这个形状——明细里一条都没有，但那已经是报告在撒谎，解析器
 * 能做的是不替它背书。
 *
 * `depth` 是「问题小标题至少得多深」，跟着栏目的写法走：加粗标签那一版栏目是段落、问题
 * 是 `###`；栏目写成 `###` 时问题就得是 `####`。写死成 `>= 3` 的话，栏目自己那一级的
 * 标题就能冒充问题小标题，① 和 ② 一起被绕开。
 *
 * 契约档里条目超过 5 条时，顺带把**摘要内部第二层折叠**的两个切点算出来（`fold`）。
 * 数得出条目在哪，正是 ② 那两道验证的副产物：每条问题都有自己的小标题、条数跟报告
 * 自己报的数对得上——所以「第 6 条从哪一行开始」是证出来的，不是猜的。
 */
function provesContract(
  root: Parsed,
  probes: string[],
  columns: Column[],
  depth: number,
): Proof | null {
  if (columns.length !== MARK_LINES.length) return null;
  if (!columns.every((hit, order) => hit.column === order)) return null;
  const [verdict, works, problems, aside] = columns;
  const declared = declaredCount(probes.slice(verdict.at, works.at).join("\n"));
  const items: Array<{ at: number; depth: number }> = [];
  for (const node of root.children) {
    if (node.type !== "heading" || node.depth < depth || !node.position) continue;
    const at = node.position.start.line - 1;
    if (at > problems.at && at < aside.at) items.push({ at, depth: node.depth });
  }
  // 「没有发现问题」只有在报告自己也没报出问题数时才算数（没报数和报了 0 条都行）。
  if (!items.length) {
    return saysNoProblem(probes, problems, aside) && !declared ? { kind: "contract" } : null;
  }
  if (!items.every((item) => writesProblem(root, probes, item.at, item.depth, aside.at))) return null;
  if (declared === null) return null;
  if (declared === items.length) {
    const sixth = items[SUMMARY_ITEMS];
    if (!sixth) return { kind: "contract" };
    return {
      kind: "contract",
      fold: { more: sixth.at, aside: aside.at, rest: items.length - SUMMARY_ITEMS },
    };
  }
  return spillsOver(root, probes, declared, items, aside) ? { kind: "lead" } : null;
}

/**
 * 摘要里最多铺开几条问题（`server/src/review-report-format.ts` 里写给审查者的也是这个数，
 * 用户需求原话「问题按用户会踩到的严重程度排，**最多 5 条**」）。
 *
 * 超出的部分有两条路，取决于报告自己怎么写：照契约在第 5 条后面写一行分流声明、完整三行
 * 放进明细的，走 `spillsOver`（折叠里有问题，降到 `lead`）；把 6 条以上全写在摘要里的，
 * 格式其实没错——错的是它默认铺了满屏——所以留在契约档，由 `fold` 在摘要内部再折一层。
 */
const SUMMARY_ITEMS = 5;

/** 中文数字的个位。`两` 跟 `二` 同值——「有两条」是真实写法。 */
const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 「有 N 条」里的 N，阿拉伯数字和中文数字都认；没报数返回 `null`（跟「报了 0 条」不是一回事）。 */
function declaredCount(text: string): number | null {
  const arabic = text.match(/有\s*(\d+)\s*条/);
  if (arabic) return Number(arabic[1]);
  const chinese = text.match(/有\s*([零〇一两二三四五六七八九十]+)\s*条/);
  return chinese ? fromChinese(chinese[1]) : null;
}

/** 个位、`十`、`十X`、`X十`、`X十Y`。再大的数没人用中文写，认不出就当没报数。 */
function fromChinese(word: string): number | null {
  const ten = word.indexOf("十");
  if (ten < 0) return word.length === 1 ? CN_DIGITS[word] ?? null : null;
  const high = ten === 0 ? 1 : CN_DIGITS[word.slice(0, ten)];
  const rest = word.slice(ten + 1);
  const low = rest === "" ? 0 : CN_DIGITS[rest];
  return high === undefined || low === undefined ? null : high * 10 + low;
}

/**
 * 「能不能验收」里报的数比摘要里的条目多时，唯一说得通的解释：契约允许**摘要里最多展开
 * 5 条**，更多的在第 5 条后面写一行「其余 N 条：<标题>、<标题>……完整写在下面的技术明细
 * 里」，完整三行放进明细（`server/src/review-report-format.ts`）。
 *
 * 认出这个形状**不是为了放行契约档**——这种报告的折叠里确实躺着第 6 条往后的问题，按钮
 * 不准替它宣称「里面只有验证过程、证据、清场记录」。认出来是为了知道「从第二个 `##` 起
 * 折」对这份报告安全：5 条问题和那行分流声明都留在首屏，余下的收进什么都不宣称的「展开
 * 完整报告」。所以这里返回真，`provesContract` 给的是 `lead` 而不是 `contract`。
 *
 * 判据要求三件事，都是「这真是那一行」而不是「某处出现过这几个字」：
 *
 * ① 位置：得在**第 5 条之后**，而且是问题栏里一个**独立的顶层段落**。曾经只在问题栏开头
 *    64 行里搜「其余 N 条」，于是第一条问题的现象写成「页面只显示其余 3 条记录」就够了。
 *    「独立段落」这个判据跟栏目候选同一套白名单（`markCandidateStarts`），围栏、引用、
 *    嵌套列表里的同样一行都不算。
 * ② 数目：N 必须正好是 `声明总数 - 5`。不校验时「有 8 条」配「其余 1 条」也能过。
 * ③ 冒号后面得真有字。
 *
 * 剩下那一半——明细里到底有没有第 6 条往后的完整三行——**这里不验，也验不动**：契约允许
 * 它们写在任何一节里，报告把「其余 3 条：详见明细」写成一句空话时，是报告在骗人。解析器
 * 管得住的只有自己那句承诺，所以这一档根本不发那句承诺。
 */
function spillsOver(
  root: Parsed,
  probes: string[],
  declared: number,
  items: Array<{ at: number }>,
  aside: Column,
): boolean {
  const last = items[SUMMARY_ITEMS - 1];
  if (items.length !== SUMMARY_ITEMS || declared <= SUMMARY_ITEMS || !last) return false;
  const rest = new RegExp(
    `^ {0,3}(?:[-*+]\\s+|\\d+[.)]\\s+)?\\s*其余\\s*${declared - SUMMARY_ITEMS}\\s*条\\s*[：:]\\s*\\S`,
  );
  return markCandidateStarts(root, last.at, aside.at)
    .some((at) => rest.test(probes[at].replace(/\*\*/g, "")));
}

/**
 * 契约给每条问题定死的三行（`server/src/review-report-format.ts`：「每条一个小标题，固定
 * 三行」）：第一行「你会遇到」写现象，第二行「为什么」讲机制，第三行「建议怎么修」。
 *
 * 比对前先把加粗记号去掉，所以三种真实写法一次认全：加粗写不写、冒号在加粗里还是外面、
 * 前面带不带列表符号。**冒号后面必须真有字**——`你会遇到：` 后面空着是模板占位，不是
 * 一条问题。
 */
const PROBLEM_LINES = ["你会遇到", "为什么", "建议怎么修"].map(
  (mark) => new RegExp(`^ {0,3}(?:[-*+]\\s+|\\d+[.)]\\s+)?\\s*${mark}\\s*[：:]\\s*\\S`),
);

/**
 * 这段行号范围里，哪些行是**正文**——顶层段落，以及顶层列表直属项里的段落。
 *
 * 白名单跟 `markCandidateStarts` 同一套，理由也一样：围栏、HTML 块、块引用、嵌套列表里
 * 的字看着顶格，解析树里各有归属。第 6 轮的反例就是围栏——一段「写法示例」代码块里照着
 * 模板写了那三行，按源码逐行扫就成了一条真问题，真正的问题被折进明细。黑名单永远缺一
 * 条，白名单漏掉一种写法只是不拆。
 *
 * 这里收**节点覆盖的每一行**而不是起始行：那三行是一段里的三个软换行，本来就该整段收。
 */
function proseLines(root: Parsed, from: number, to: number): Set<number> {
  const lines = new Set<number>();
  const take = (node: ParsedNode) => {
    if (!node.position) return;
    for (let at = node.position.start.line - 1; at <= node.position.end.line - 1; at += 1) {
      if (at >= from && at < to) lines.add(at);
    }
  };
  for (const node of root.children) {
    if (node.type === "paragraph") take(node);
    else if (node.type === "list") {
      for (const item of node.children) {
        for (const child of item.children) if (child.type === "paragraph") take(child);
      }
    }
  }
  return lines;
}

/**
 * `at` 那个小标题底下**真写着一条问题**，不是别的什么。
 *
 * 曾经只数「第三、四栏之间有没有一个够深的标题」，于是任何一个说明性小标题都能冒充问题
 * 条目：`#### 补充说明` + 「真正的问题见下方。」照样判成契约，那一条真正的问题写在后面的
 * `##` 里，首屏只剩「有 1 条必须先修」和「补充说明」，按钮还宣称折叠里只有技术记录。
 * 这跟第 4 轮「『没有发现问题』被当子串」是同一个形状：判据比它要证明的事松一档。
 *
 * 所以照契约验那三行——**按序、各自独占一行的开头、冒号后有字，而且那一行得是正文**。
 * 三处都被绕过过：不验顺序和行首就是子串问法（「这里不写你会遇到、为什么、建议怎么修」
 * 一句话就够）；不验节点类型，围栏里的写法示例算数；不验冒号后有没有字，空模板算数。
 *
 * 条目正文止于下一个同级或更浅的标题（同一栏里的下一条问题），最远到第四栏。
 */
function writesProblem(root: Parsed, probes: string[], at: number, depth: number, until: number): boolean {
  const sibling = root.children.find(
    (node) =>
      node.type === "heading" && node.depth <= depth && node.position
      && node.position.start.line - 1 > at,
  );
  const end = Math.min(until, sibling?.position ? sibling.position.start.line - 1 : until);
  const prose = proseLines(root, at + 1, end);
  let cursor = at + 1;
  for (const line of PROBLEM_LINES) {
    let hit = -1;
    for (let scan = cursor; scan < end; scan += 1) {
      if (prose.has(scan) && line.test(probes[scan].replace(/\*\*/g, ""))) { hit = scan; break; }
    }
    if (hit < 0) return false;
    cursor = hit + 1;
  }
  return true;
}

/**
 * 第三栏是不是**整栏只写了**「没有发现问题」——契约的原话就是「没有问题时，这一栏只写
 * 『没有发现问题』六个字」（`server/src/review-report-format.ts`）。
 *
 * 曾经问的是「这一栏有没有哪一行**包含**这六个字」，于是否定句把判据整个翻了过来：
 * 「详情见下方；这里不是说没有发现问题」照样算「没有问题」，那一条真正的问题写在后面的
 * `##` 里，首屏只剩「有 1 条必须先修」和「详情见下方」，按钮还宣称折叠里是技术明细。
 * 引文、注释、代码示例里出现同样的字样也一样能骗过去。
 *
 * 所以改成**整栏比对**：去掉加粗记号和栏目标签本身，余下的可见字符必须一个不多、正好是
 * 那六个字（容一个句号）。这不是又一次收紧前缀匹配，是换了个问法——前者问「出现过吗」，
 * 后者问「除了它还写了别的吗」，后者没有「混进来」的余地。
 */
function saysNoProblem(probes: string[], problems: Column, aside: Column): boolean {
  const label = new RegExp(`^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)?#{0,6}\\s*${CONTRACT_MARKS[2]}\\s*[：:]?`);
  const body = probes
    .slice(problems.at, aside.at)
    .join("\n")
    .replace(/\*\*/g, "")
    .replace(label, "")
    .replace(/\s+/g, "");
  return body === "没有发现问题" || body === "没有发现问题。";
}

export function splitReviewReport(text: string): ReviewReportSections {
  const whole: ReviewReportSections = { summary: text, more: "", rest: 0, aside: "", detail: "", kind: "whole" };
  // 解析器把孤立的 `\r` 也当换行，我们按 `\n` 切片——真碰上这种老式换行，行号就对不上了。
  // 对不上时一律整篇铺开（两档都不给）：认不出只是啰嗦，按错的行号拆是把内容藏掉。
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
  // 匹配用的是去掉行尾 `\r` 的副本，切片仍用原始行——这样 CRLF 报告认得出，返回的正文
  // 又跟入参逐字节一致（不悄悄替换用户的换行）。踩过的坑在正则语义：`\r` 是行终结符，
  // `.` 不匹配它、不带 `m` 的 `$` 只认串尾，于是 `**能不能验收**：不能\r` 认不出来。
  const probes = lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  /**
   * 按切点把原文分成首尾相接的几段。切点全部来自解析树里**顶层节点的起始行**，所以每一
   * 刀都落在两个块之间——不会切进围栏、列表项或表格内部。段与段之间只有切点上被
   * `trimEnd()` 吃掉的空白，其余字节原样。
   */
  const cut = (at: number, proof: Proof): ReviewReportSections => {
    const slice = (from: number, to?: number) => lines.slice(from, to).join("\n").trimEnd();
    const fold = proof.fold;
    if (!fold) {
      return { summary: slice(0, at), more: "", rest: 0, aside: "", detail: slice(at), kind: proof.kind };
    }
    return {
      summary: slice(0, fold.more),
      more: slice(fold.more, fold.aside),
      rest: fold.rest,
      aside: slice(fold.aside, at),
      detail: slice(at),
      kind: proof.kind,
    };
  };

  /**
   * 首节标题是不是**报告自己声明的「这一节是给人看的判定」**。
   *
   * 判据是整段标题全文相等（容一个协议判定词后缀），不是「含结论二字」——差别就是
   * `## 0. 先说结论之外的：这轮做对的部分` 和 `## 一、先说结论：核心功能是真的能用`
   * 这两份真实报告：它们把正面那半写在首节、【高】写在后面的 `##` 里，认成结论节就会
   * 把发现折走。（`## 结论：核心功能是真的能用` 同理，落不进这个正则。）
   *
   * 认英文是第 4 轮补的：判据本来写死成中文「结论」，于是 `## Conclusion` / `## Verdict`
   * 开场的报告一份都折不了——全库 13 份整篇铺开的报告里，最长那份 222 行就是这个形状。
   * 语言不是判据，「报告把判定写在哪」才是。第 5 轮同理补上 `Findings` / `发现`：全库
   * 323 份报告把发现写在首节，尾部清一色是验证记录、浏览器通道和清理。
   */
  const title = plainText(head).trim();
  if (VERDICT_TITLES.test(title)) {
    // 没有第二个 `##` 时折掉的就是整个结论节，那还不如整篇铺开。
    if (!next?.position) return whole;
    const second = next.position.start.line - 1;
    // 这一节里**提没提过栏目名**，决定了它是「旧格式」还是「新格式写坏了」——两者的安全
    // 方向正相反，所以判在最前面：
    //
    // - 一个栏目名都没出现 = 旧格式的结论节。这类报告的判定就写在这一节里，从第二个 `##`
    //   起折才对（全库 164 份首个 `##` 是「结论」的报告，146 份是这个样子）。
    // - 出现过 = 有人在照新格式写、只是没写对。这类报告的问题**本来就该写在结论节里**，
    //   从第二个 `##` 起折会连问题一起折掉（第 2 轮把第三栏写成 `## 必须修的问题`、第 10
    //   轮把那条问题写成 `##`，都是这个形状）。一律整篇铺开。
    //
    // 判「提过没有」而不是「凑齐加粗标签没有」，是因为差的那一档正好是危险的那一档：
    // 「我按模板核对了能不能验收、现在什么能用了……」这种正文提及凑不出签名，却足以说明
    // 后面那个 `##` 可能就是问题小节。认错方向的代价不对称，宁可多铺开 18 份。
    const section = probes.slice(first, second).join("\n");
    if (!CONTRACT_MARKS.some((mark) => new RegExp(mark).test(section))) return cut(second, { kind: "lead" });
    // 只有**证明得了自己按新契约写**的报告才走第一档。把发现藏进一个写着「验证过程、证据、
    // 清场记录」的折叠里，比让人多滚两屏严重得多，这一档不留猜的余地：降一档只是多点一下
    // 按钮，认错成契约是让按钮替报告撒谎。
    //
    // 契约档的标题闸比折点那道**严**：prompt 要求原样写「## 结论」，所以这里只认这两个字。
    // 拿「报告自己声明这节是结论」决定**摘要到哪为止**可以，拿它当**四栏契约成立**的证据
    // 不行——第 10 轮那份 `## 前言` 里整段抄着上一轮四项结论的报告就是后者的反例。
    if (title !== "结论") return whole;
    // 四栏有两种写法，都认（判据见 `provesContract`）：prompt 给的加粗标签段落，以及把同样
    // 四个栏目写成 `###` 小标题。后者是真实存在的形态——全库 1036 份里 4 份长这样，其中
    // 一份就是本任务上一轮的审查报告。它在结构上跟加粗版一样确定（标题的可见文字必须精确
    // 等于栏目名），认不出的后果却是整份技术明细重新铺满首屏，正好是这次改动要消灭的东西。
    const columns = markCandidateStarts(root, first, second)
      .map((at) => ({ at, column: MARK_LINES.findIndex((pattern) => pattern.test(probes[at])) }))
      .filter((hit) => hit.column >= 0);
    const proven = provesContract(root, probes, columns, 3)
      ?? provesContract(root, probes, headingColumns(root, first, second), 4);
    if (!proven) return whole;
    return cut(second, proven);
  }

  /**
   * 第二档 · 报告自己标了严重度：开头连着的那几节问题全部留在首屏，从第一个没标的 `##`
   * 起折。
   *
   * 这不是「按标题猜哪一节像摘要」——`## [中] 筛选状态下点击…` 已经把「这是一条问题、
   * 多严重」写在标题上了，比任何猜法都确定。拆点也不靠猜：**所有标了严重度的小节都留在
   * 首屏**，折的是它们后面的验证记录、浏览器通道和清场。真实形态是 `-MseXJQXVHVH` 的四轮
   * 报告，原先整篇铺开四五十行。
   */
  const tail = heads.findIndex((node) => !SEVERITY_TITLES.test(plainText(node).trim()));
  const fold = tail > 0 ? heads[tail]?.position : undefined;
  if (SEVERITY_TITLES.test(title) && fold) return cut(fold.start.line - 1, { kind: "lead" });

  /**
   * 第二档 · 通用形态：引子铺开，第一个 `##` 起收进「展开完整报告」。
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
  return told ? cut(first, { kind: "lead" }) : whole;
}
