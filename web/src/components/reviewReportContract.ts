// 「这份报告能证明什么」——契约识别的全部判据。切在哪、切成几段是另一件事，在
// `reviewReportSections.ts`。
//
// 拆开是因为那一份写到 695 行（上限 700）。两边的分工是天然的：这一份只回答「四栏齐不齐、
// 问题写全没有、条数对不对得上、报告有没有自相矛盾」，一个字都不碰切片；那一份拿着这里
// 给的结论决定从哪一刀下手。
//
// 每一条判据背后都有一份真实报告或一轮反例，改之前先读它头上那段注释——十一轮下来被打回
// 的形状**从来只有一种**：判据比它要证明的事松一档，于是首屏写着有问题，问题本身进了那个
// 宣称「里面只有验证过程、证据、清场记录」的折叠。拿不准一律降档：降错一档只是多点一下
// 按钮，认错成契约是让按钮替报告撒谎。
import { fromMarkdown } from "mdast-util-from-markdown";

/**
 * `provesContract` 的结论：判到哪一档，以及摘要要不要再分一层。
 *
 * `fold` 只在契约档给：四栏齐全、每条问题写全三行、条数也对得上，**但条目多到摘要
 * 一屏放不下**。这时折叠里确实只有技术记录（契约档的担保没变），铺开的那一段却重新
 * 变成一堵问题墙——用户要的「打开先看见结论」在第 6 条往后就失效了。所以摘要自己
 * 再分一层，前 5 条铺开，其余收进一个照实说话的按钮。
 */
export type Proof = {
  kind: "contract" | "lead";
  /** 摘要内部的两个切点（第 6 条的起始行、第四栏的起始行），加上按钮上的 N。 */
  fold?: { more: number; aside: number; rest: number };
};

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
export function provesContract(
  root: Parsed,
  probes: string[],
  columns: Column[],
  depth: number,
  tail: number,
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
  // 「没有发现问题」这条岔路要过三道闸，缺一道就有一份自相矛盾的报告能把真问题藏进
  // 一个写着「验证过程、证据、清场记录」的按钮后面。三道分别挡住三种矛盾写法，判据见
  // `saysNoProblem` / `admitsAcceptance` / `hidesProblem`。
  if (!items.length) {
    if (!saysNoProblem(probes, problems, aside)) return null;
    if (declared) return null;
    if (!admitsAcceptance(probes, verdict, works)) return null;
    if (hidesProblem(root, probes, tail)) return null;
    return { kind: "contract" };
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
 * 第一栏**整段就是一句明确的验收结论**——「没有发现问题」那条岔路的第二道闸。
 *
 * 第 8 轮堵的是「报了数就得对上」，可条数只是报告表达矛盾的一种写法。第 1 轮（复审）
 * 的反例换了个写法就绕过去了：`**能不能验收**：不能验收，请修完再验` 压根不报数，
 * `declaredCount` 返回 `null`，零条目分支于是照放——首屏同时写着「不能验收」和「没有
 * 发现问题」，真正的问题在下一个 `##` 里，按钮还替它宣称折叠里只有技术记录。
 *
 * 于是问法从「有没有反面证据」换成「有没有正面证据」。接下来三轮，每一轮的反例都在说
 * 同一句话：**只要还有一块地方是按词表判的，下一种措辞就从那里进来**。
 *
 * 第 2 轮——整段搜正面子串：`不建议通过` `暂缓通过` `not verified` `测试通过，但暂不验收`
 * 四句都是不能验收，整段里却都躺着一个正面词。于是收到主句上搜。
 *
 * 第 3 轮——主句里搜子串还是搜子串：`测试通过，尚待人工验收` 的主句是「测试通过」，
 * 「功能正常」里有个「能」，`yesterday's checks were green` 里有个「yes」。于是正面这一侧
 * 改成白名单、比的是主句整体。
 *
 * 第 4 轮——**主句合格了，尾巴还在**。这几句的主句一个字都没错，反悔全写在后面：
 *
 *   可以验收，但保存问题仍未解决
 *   verified — save bug remains
 *   verified — rejected by QA
 *   verified — needs fixes
 *   verified — no issues resolved; changes are still required
 *
 * 当时尾巴是用否定词表和未决词表排除的，这几句一个固定词都没共用。继续添词追不上——
 * 添的是反例的措辞，漏的永远是下一种。
 *
 * 所以整栏一起收进白名单，不再留任何黑名单：
 *
 * ① 整栏按标点（括号也算）切成若干段，**每一段都得有人认领**。
 * ② 第一段必须整体落在 `ACCEPTS` 里——一句当前的验收判定，不是测试或功能的状态。
 * ③ 其余每一段必须整体落在 `ACCEPTS` 或 `SAFE_TAILS` 里——判定的同义重复（`通过（verified）`）
 *    或者一句说得死的「没有问题」（`有 0 条必须先修`、`no blockers`）。
 *
 * 认不出的段落一律降档。这就是这套判据唯一的立场：**白名单漏一条的代价是多铺开一屏，
 * 黑名单漏一条的代价是按钮替报告撒谎**。两者不对称，所以宁可漏在白名单这边。
 *
 * 标签得先去掉——栏目名「能不能验收」自己就带着「不能」两个字；前导空白也得去掉，四栏
 * 写成 `###` 时正文在标题的下一行，不 `trim` 的话第一段会切出一个空串。
 *
 * 真实语料里走这条岔路的报告一共 6 份：5 份写的是「可以验收」「能验收」，第 6 份写的是
 * 「可以 —— 第 1 轮的 2 条都已修复，本轮没有发现必须先修的问题。」——「第 1 轮的 2 条都
 * 已修复」是自由文本，按这套判据降档。那是这次收紧的全部代价：那一份报告的技术记录会
 * 铺开在首屏，问题一条都不会被藏起来。
 */
/** 切段的分隔符：标点（中英文都算，破折号也算）和括号。空白不算——`no blockers` 是一段。 */
const CLAUSE_SPLIT = /[，,。；;：:—–、!！?？\n（）()[\]【】/|]+/;
/**
 * 一句**当前的验收判定**。比的是整段，不是「含有」——差别正是第 3 轮那几个反例：
 * 「测试通过」含「通过」但不是「通过」。
 */
const ACCEPTS = new RegExp(`^(?:${[
  "可以(?:验收|通过)?",
  "能(?:验收|通过)?",
  "可验收",
  "(?:验收)?通过",
  "通过验收",
  "同意(?:验收)?",
  "建议验收",
  "verified",
  "pass(?:ed)?",
  "approved",
  "accepted",
  "yes",
  "ok(?:ay)?",
  "lgtm",
].join("|")})$`, "iu");
/**
 * 判定之后还允许写什么。只收**整段说死了「没有问题」**的写法：条数为零、没有发现问题、
 * 全部通过、`no blockers`。多一截自由文本（`no blockers were fixed`）不认——那是第 4 轮
 * 的反例。
 *
 * 英文那条的形容词位是**白名单**，不是任意单词。第 4 轮为了认出 `no blocking issues`
 * 开了个 `\w+`，第 5 轮的反例就从那里进来：`no fixed issues`、`no resolved blockers`、
 * `no addressed problems`——说的全是「没有已经修好的问题」，正好反着。形容词只收「还没
 * 处理」那一侧的词，「已处理」那一侧一个都不收。
 */
const SAFE_TAILS = [
  /^有?\s*0\s*条(?:必须先修|要修|需要先修|必须修)?(?:的问题)?$/u,
  /^(?:本轮)?(?:没有|无)(?:发现)?(?:任何)?(?:必须先修的|需要先修的|拦验收的|阻塞的)?问题$/u,
  /^(?:本轮)?(?:没有|无)(?:发现)?(?:任何)?(?:必须先修的|需要先修的|拦验收的|阻塞的)?(?:问题|风险|缺陷)$/u,
  /^全部(?:通过|修复|已修复)$/u,
  /^(?:全部)?(?:都)?已(?:全部)?修复$/u,
  /^no\s+(?:blocking|open|outstanding|remaining|pending|known|critical|major|new|other)?\s*(?:blocker|issue|problem|concern|risk|regression)s?$/iu,
  /^(?:all\s+)?(?:checks?\s+)?(?:pass|passed|green)$/iu,
];

/**
 * 这条判定**被划掉、被否掉、或者还没勾**。这些记号是内容，不是装饰。
 *
 * 第 5 轮的反例：`~~可以验收~~`、`❌ 可以验收`、`[ ] 可以验收`。当时两头是按 `\p{P}\p{S}`
 * 一律剥掉的，删除线、红叉、空的任务框全被洗成一句裸的「可以验收」——洗掉的恰好是那句话
 * 的**反面**。`[x]`（已勾选）是另一回事，由 `CHECKED` 单独剥掉。
 */
const REVOKED = /~~|❌|❎|✗|✘|🚫|\[\s*\]|☐|▢/u;
/** 开头的「已勾选」记号：剥掉它跟没写是一个意思。空框不在这里——那是 `REVOKED`。 */
const CHECKED = /^\s*\[\s*[xX✓✔]\s*\]\s*/u;
/**
 * 两头能当装饰剥掉的**只有这些**：空白、强调、引号、勾选。
 *
 * 不再按 `\p{P}\p{S}` 通剥——那个范围把删除线和红叉也算成装饰（第 5 轮）。句号、破折号
 * 这类真正的标点不用在这里管，它们本来就是 `CLAUSE_SPLIT` 的分隔符。
 */
const DECOR = /[\s*_`"'“”‘’「」『』·•…✅✔☑🟢👍]/u;
const trimMarks = (part: string) => part
  .replace(new RegExp(`^(?:${DECOR.source})+`, "u"), "")
  .replace(new RegExp(`(?:${DECOR.source})+$`, "u"), "");

function admitsAcceptance(probes: string[], verdict: Column, works: Column): boolean {
  const label = new RegExp(`^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)?#{0,6}\\s*${CONTRACT_MARKS[0]}\\s*[：:]?`);
  const body = probes
    .slice(verdict.at, works.at)
    .join("\n")
    .replace(/\*\*/g, "")
    .replace(label, "")
    .replace(CHECKED, "");
  // 划掉的、打叉的、没勾的，先于一切判断——后面的切段会把方括号当分隔符，空框在那一步
  // 就没了。
  if (REVOKED.test(body)) return false;
  const parts = body
    .split(CLAUSE_SPLIT)
    .map(trimMarks)
    .filter((part) => part !== "");
  const [first, ...tail] = parts;
  if (!first || !ACCEPTS.test(first)) return false;
  return tail.every((part) => ACCEPTS.test(part) || SAFE_TAILS.some((safe) => safe.test(part)));
}

/**
 * 第二个 `##` 之后**还躺着一条按契约写全三行的问题**——「没有发现问题」那条岔路的第三道闸。
 *
 * 摘要说没问题、明细里却有一条完整的问题，这份报告同样在自相矛盾，方向只是反过来：不是
 * 「说了有、藏起来」，是「说了没有、其实有」。两种的后果一样——按钮替报告宣称折叠里只有
 * 验证过程、证据和清场记录，而那里面装着一条问题。
 *
 * 判据复用 `writesProblem`，跟摘要里认问题用的是同一把尺：一个小标题带着按序的那三行、
 * 各自独占行首、冒号后有字、而且得是正文。松一档（比如只搜「你会遇到」四个字）会把明细
 * 里复述证据的段落也算成问题，白白把合规报告降档；紧一档（比如要求标题层级）又会漏掉
 * 报告随手写成 `##` 的那一条。
 *
 * **只在零条目分支上问这一句**。正常的契约档（摘要里逐条写了问题）明细里本来就允许复述
 * 每条问题的证据，那是契约要的东西，不是矛盾。
 *
 * 边界含 `tail` 本身，不是 `tail` 之后。复审第 2 轮的反例就差这一个等号：那条问题**自己
 * 就是第二个 `##`**（`## 保存后内容消失` 底下直接跟三行），`at === tail` 被跳过，于是报告
 * 照判契约、问题照样进折叠。摘要里的条目不会因此被重复扫到——它们都在第一、第二个 `##`
 * 之间，行号严格小于 `tail`。
 */
function hidesProblem(root: Parsed, probes: string[], tail: number): boolean {
  for (const node of root.children) {
    if (node.type !== "heading" || node.depth < 2 || !node.position) continue;
    const at = node.position.start.line - 1;
    if (at < tail) continue;
    if (writesProblem(root, probes, at, node.depth, probes.length)) return true;
  }
  return false;
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
