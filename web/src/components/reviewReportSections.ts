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
// ② 认不出契约（存量报告、某轮审查者没照 prompt 写）就降一档：铺开的那一段留在首屏，
//    余下全部收进一个不作任何承诺的「展开完整报告」。这是用户点名要的结构保证——「就算
//    某轮审查者没照 prompt 写，你也不会被 46 行合规证明糊一脸」。折在哪看报告自己怎么写：
//    - 首节标题就是「这是结论」的声明（`## 结论` / `## Conclusion` / `## Verdict` /
//      `## 结论：verify_failed`）：整节留在首屏，从**第二个** `##` 起折。折在第一个 `##`
//      之前会把判定一起折掉；只认中文那一个词，222 行的英文报告就一份都折不了。
//    - 其它形态：开头到**第一个** `##` 之前的引子留在首屏。
// ③ 首屏凑不出读得懂的东西（开头只有标题、首节又不是报告自己声明的结论节，或者声明了
//    却没有第二个 `##`）就整篇铺开：一个标题加一个按钮的首屏，比多滚两屏更糟。
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

export type ReviewReportSections = {
  /** 铺开的那一半：按契约拆时是「一级标题 + 摘要那一节」，降级时是第一个 `##` 之前的引子。 */
  summary: string;
  /** 收进开关的那一半；为空表示这篇没拆，别画展开按钮。 */
  detail: string;
  /**
   * 折叠里装的是什么——**按钮文案只能照它写**。
   *
   * - `"whole"`：没拆，`detail` 为空。
   * - `"contract"`：按新契约拆的，折叠里只有技术记录，可以这么写在按钮上。
   * - `"lead"`：存量报告的粗拆，折叠里是报告余下的**全部**内容，**可能包含问题本身**，
   *   所以按钮不准替它宣称里面是什么。
   */
  kind: "whole" | "contract" | "lead";
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
 * 首个 `##` 写成这样，就算**报告自己声明了「这一节是结论」**——整节留在首屏，从第二个
 * `##` 起才折。
 *
 * 全文相等，不是「含结论二字」；后缀只容协议自己的判定词（`## 结论：verify_failed` 是
 * 真实形态）。放宽到前缀的代价见 `splitReviewReport` 里那段注释。
 */
const CONCLUSION_TITLES = /^(?:结论|Conclusion|Verdict)\s*(?:[：:]\s*(?:verified|verify_failed|blocked))?$/i;

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
 *    （`server/src/review-report-format.ts`）：要么每条问题一个小标题，要么只写「没有
 *    发现问题」六个字。
 *
 * `depth` 是「问题小标题至少得多深」，跟着栏目的写法走：加粗标签那一版栏目是段落、问题
 * 是 `###`；栏目写成 `###` 时问题就得是 `####`。写死成 `>= 3` 的话，栏目自己那一级的
 * 标题就能冒充问题小标题，① 和 ② 一起被绕开。
 */
function provesContract(root: Parsed, probes: string[], columns: Column[], depth: number): boolean {
  if (columns.length !== MARK_LINES.length) return false;
  if (!columns.every((hit, order) => hit.column === order)) return false;
  const [, , problems, aside] = columns;
  const listed = root.children.some(
    (node) =>
      node.type === "heading" && node.depth >= depth && node.position
      && node.position.start.line - 1 > problems.at
      && node.position.start.line - 1 < aside.at,
  );
  return listed || saysNoProblem(probes, problems, aside);
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
  const whole: ReviewReportSections = { summary: text, detail: "", kind: "whole" };
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
  const cut = (at: number, kind: "contract" | "lead"): ReviewReportSections => ({
    summary: lines.slice(0, at).join("\n").trimEnd(),
    detail: lines.slice(at).join("\n").trimEnd(),
    kind,
  });

  /**
   * 首节标题是不是**报告自己声明的「这一节是结论」**。
   *
   * 判据是整段标题全文相等（容一个协议判定词后缀），不是「含结论二字」——差别就是
   * `## 0. 先说结论之外的：这轮做对的部分` 和 `## 一、先说结论：核心功能是真的能用`
   * 这两份真实报告：它们把正面那半写在首节、【高】写在后面的 `##` 里，认成结论节就会
   * 把发现折走。（`## 结论：核心功能是真的能用` 同理，落不进这个正则。）
   *
   * 认英文是第 4 轮补的：判据本来写死成中文「结论」，于是 `## Conclusion` / `## Verdict`
   * 开场的报告一份都折不了——全库 13 份整篇铺开的报告里，最长那份 222 行就是这个形状。
   * 语言不是判据，「报告把判定写在哪」才是。
   */
  const title = plainText(head).trim();
  if (CONCLUSION_TITLES.test(title)) {
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
    if (!CONTRACT_MARKS.some((mark) => new RegExp(mark).test(section))) return cut(second, "lead");
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
    if (!provesContract(root, probes, columns, 3) && !provesContract(root, probes, headingColumns(root, first, second), 4)) {
      return whole;
    }
    return cut(second, "contract");
  }

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
  return told ? cut(first, "lead") : whole;
}
