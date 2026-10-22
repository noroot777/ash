// 一份 Markdown 里 `![](…)` 到底指到哪儿 —— 服务端、展示端和**真正的渲染器**共用的唯一口径。
//
// 为什么非得是同一份:服务端按它决定「把哪些本机图片复制进 uploads、标成正文哪一句引用
// 的」,展示端按它决定「正文里哪一处该换成站内地址、哪一张附件已经被正文领走」,而最终
// 画出来的是 `react-markdown`。三家只要有一家口径不同,立刻出现两种错:存了而配不上
// (图没了),或者认领了而渲染器不认(附件卡片被吃掉、正文又什么都画不出来)。
//
// 所以这里**不再自己判语法**,直接用渲染器那颗解析树(`mdast-util-from-markdown`,
// `react-markdown` 内部就是它;`web/src/components/MarkdownBody.tsx` 渲染的是同一份正文,
// `server/src/review-history.ts` 当初也是为了同一个理由把手写行扫描器删掉的)。手写正则
// 那一版连补了两轮特判还是漏:带括号的文件名被截成 `output/result(1`、四空格缩进的写法
// 示例被当成真图改写掉、转义的 `\!` 被认成图、引用式图整个漏掉(审查第 1 轮 F2)。成因是
// 同一个 —— **正则表达不了块结构和转义**,补第三第四种特判只会把这条链接着往下拖。
//
// 仍然不认的只剩一种:裸 `<img>` 标签。那是对的 —— 这个应用没装 `rehype-raw`,渲染器自己
// 也不画它,认了反而会凭空多出一张卡片。
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

// **方言必须跟渲染器一字不差**:`web/src/components/MarkdownBody.tsx` 挂的是 `remarkGfm`,
// 而 remark-gfm 就是这两个扩展。少挂它们,同一段正文两边认出的图片节点集合**不是一个**
// (审查第 2 轮 F2 实测:脚注里的真截图 core=0 / gfm=1 —— 存不下也画不出来;表格单元里带
// 未转义 `|` 的写法 core=1 / gfm=0 —— 服务端当成真图存一份、改写之后 GFM 里反而凭空多出
// 一张图)。所以解析参数在这里**定义一次**,服务端和展示端都从这个文件拿。
const GFM = { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] };

export type MarkdownImageRef = {
  /** 目的地:转义与字符实体已由解析器解开(`![](a\(1\).png)` → `a(1).png`),`<>` 已剥掉。 */
  destination: string;
  /** 这一处引用在原文里占的那一段(半开区间)。 */
  start: number;
  end: number;
  /** 换成站内地址后这一段该写什么(见 rewriter)。 */
  rewrite: (url: string) => string;
  /**
   * 渲染器真会把它画出来吗。
   *
   * 只有一种情形是假:它住在一条**没人引用的脚注定义**里。脚注那一节是渲染器按
   * `footnoteReference` **建出来的**(mdast-util-to-hast),没有任何 `[^x]` 指向的定义整节
   * 被丢掉 —— 解析树里它是货真价实的图片节点,屏幕上一个像素都没有(实测:referenced 扫
   * 1 处画 1 张、orphan 扫 1 处画 0 张)。
   *
   * 为什么是标记而不是直接不认它:服务端是**流式**扫的,定义先到、引用后到时「有没有人
   * 引用」还没有答案,这时候不存那份拷贝,等引用真的到了就再也没有字节了。所以扫描器照
   * 旧逐处交代(服务端宁可多存一份),而展示端**不许认领**它的卡片 —— 不然就是这个文件
   * 开头那两种错的后一种:认领了而渲染器不认,卡片被吃掉、正文又什么都画不出来。
   */
  rendered: boolean;
};

/**
 * 带协议的目标(`http:`、`data:`、`blob:`、`file:`)不是「相对某个目录」的写法。
 *
 * **至少两个字符**是硬要求:`D:\work\shot.png` 的 `D:` 否则会被当成协议,Windows 上
 * 所有盘符绝对路径就都被当成站外地址扔掉(审查第 1 轮 F4,正是上一版引入的回归)。
 * 现实里没有单字母协议,而盘符恒为单字母,这条判据两边都够用。
 */
const URL_SCHEME = /^[a-z][a-z0-9+.-]+:/i;

export function hasUrlScheme(value: string): boolean {
  return URL_SCHEME.test(value.trim());
}

/**
 * 这个目的地是**浏览器要去网络上取的地址**吗 —— 服务端与展示端共用的唯一判据。
 *
 * 为什么不能只问 `hasUrlScheme`:`//cdn.example.com/a.png` 是**协议相对网址**(沿用当前
 * 页面的 http/https),它没有协议,却绝不是本机路径。只问 scheme 的那一版把它当成绝对
 * 路径:服务端去读 `/cdn.example.com/a.png`(必然失败,还白报一条「没副本」),展示端把它
 * 改写成「去任务工作目录取」,于是这张站外图**永远画不出来**(审查第 2 轮 F3)。
 *
 * 跟 Windows UNC 的分界:UNC 是 `\\server\share`(反斜杠),Windows 工具写出来的就是这个
 * 形状;`//` 在一份要交给浏览器渲染的 Markdown 里按网络地址解释。两者判据不重叠。
 */
export function isNetworkDestination(value: string): boolean {
  const raw = value.trim();
  return hasUrlScheme(raw) || raw.startsWith("//");
}

type Node = {
  type: string;
  url?: string;
  alt?: string;
  identifier?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

function* walk(node: Node): Generator<Node> {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

function parse(text: string): Node | null {
  try {
    return fromMarkdown(text, GFM) as Node;
  } catch {
    return null; /* 解析器自己崩了也不该掀掉整条事件流 */
  }
}

function offsets(node: Node): [number, number] | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return typeof start === "number" && typeof end === "number" ? [start, end] : null;
}

/**
 * 换成站内地址之后,这一处引用该怎么写。
 *
 * **整处一起重写**,而不是只替换目的地那几个字:目的地在原文里占哪一段,得先找到 alt
 * 结束的那个 `]`,而 alt 里可以有成对的、转义的方括号,还可以是引用式(`![a][ref]` —— 目的
 * 地压根不在这处)。按字符位置去找就是又一轮「补特判」,所以按解析树给的 alt 重写一遍。
 * 代价清楚:alt 里的 Markdown 标记被摊平(渲染器本来也只把 alt 当纯文本),title 被丢掉
 * (本应用的 img 不读 title)。
 */
function rewriter(alt: string): (url: string) => string {
  const label = alt.replace(/[\\[\]]/g, "\\$&");
  // 目的地里有空白或括号时必须 `<>` 包起来,否则 CommonMark 在第一个空格处就截断。
  return (url) => `![${label}](${/[\s()]/.test(url) ? `<${url}>` : url})`;
}

/**
 * 正文里每一处**渲染器真会画出来的**图片引用,按出现顺序。
 *
 * 行内图(`![a](p)`)与引用式图(`![a][ref]` + `[ref]: p`)都认 —— 后者渲染器照样画,漏掉
 * 它就是「正文显示得出图、服务端没存过」。代码块、行内代码、转义的 `\!` 里的写法一律
 * 不认:那是**示例**,不是图(渲染器也只画成代码)。
 */
export function markdownImageRefs(text: string): MarkdownImageRef[] {
  if (!text.includes("![")) return [];
  const root = parse(text);
  return root ? refsOf(root) : [];
}

function refsOf(root: Node): MarkdownImageRef[] {
  const definitions = new Map<string, string>();
  const referenced = new Set<string>();
  for (const node of walk(root)) {
    if (node.type === "footnoteReference" && node.identifier) referenced.add(node.identifier);
    if (node.type !== "definition" || !node.identifier || typeof node.url !== "string") continue;
    // 同名定义:CommonMark 取**第一条**。
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  }
  // 没人引用的脚注定义整节不渲染(见 MarkdownImageRef.rendered),里面的图片节点先圈出来。
  const hidden = new Set<Node>();
  for (const node of walk(root)) {
    if (node.type !== "footnoteDefinition" || referenced.has(node.identifier ?? "")) continue;
    for (const inner of walk(node)) hidden.add(inner);
  }
  const refs: MarkdownImageRef[] = [];
  for (const node of walk(root)) {
    const inline = node.type === "image";
    if (!inline && node.type !== "imageReference") continue;
    const span = offsets(node);
    if (!span) continue;
    const destination = (inline ? node.url : definitions.get(node.identifier ?? ""))?.trim();
    if (!destination) continue;
    refs.push({
      destination,
      start: span[0],
      end: span[1],
      rewrite: rewriter(node.alt ?? ""),
      rendered: !hidden.has(node),
    });
  }
  return refs.sort((a, b) => a.start - b.start);
}

/** 空行之后**一定**另起一块的那几种节点 —— 判据与取舍见 blockSettled。 */
const SETTLED_BLOCK = new Set(["paragraph", "heading", "thematicBreak", "table", "definition"]);

/**
 * 这个顶层块已经写完了吗(后文不可能再改它的解析结果)。
 *
 * 不对称是**故意的**:猜「还没写完」的代价只是这一块跟着后面那一段走,顺序一个字不变;
 * 猜「写完了」却猜错,一个列表会被劈成两个列表、一段引用块劈成两段 —— 渲染出来真的不一样。
 * 所以列表、引用块、缩进代码块、脚注定义一律按「还没写完」处置:它们空行之后还能接着长。
 */
function blockSettled(text: string, node: Node, span: [number, number]): boolean {
  const fenced = node.type === "code" && /^(?:```|~~~)/.test(text.slice(span[0], span[0] + 3));
  if (!fenced && !SETTLED_BLOCK.has(node.type)) return false;
  // 空行是「这一块到此为止」的唯一硬证据:段落在单个换行之后还能续写(lazy continuation),
  // 未闭合的围栏连空行都吃得下(所以围栏那一档也要空行才算完)。
  return /\n[ \t]*\n/.test(text.slice(span[1]));
}

/**
 * 「切在这里不会改变语法」的那个位置 —— 流式裁剪与气泡分段共用的唯一口径。
 *
 * 必要性:两边都会**把同一份 Markdown 按别的边界切开**。服务端按字符数攒够就裁(carry 不能
 * 无限涨),展示端按执行事件切段(工具卡片要插在正文中间)。而半截正文的语法结论随时会被
 * 后文推翻:开栏的 ``` 被裁掉之后围栏里的写法示例就成了「真图」,一对反引号被切在两段里
 * 之后后半段那个示例会被真的画出来(审查第 2 轮 F2、第 3 轮 R2 实测:整条消息 0 个图片
 * 节点,切成两段后各认出 1 个)。
 *
 * 所以切点只能落在**顶层块边界**上:未闭合的围栏、还在写的段落恒是最后一个块。
 *   · 最后一个块已经写完(见 blockSettled)→ 返回 `text.length`,整段都定型了;
 *   · 否则返回最后一个块的起点 —— 它**之前**那些块的结论不会再变;
 *   · 返回 0 = 整段正文就是一个还没写完的块,一个字都不能切。
 */
export function stableBlockBoundary(text: string): number {
  const root = parse(text);
  if (!root) return 0; /* 解析不了就什么都别切 */
  return boundaryOf(text, root);
}

function boundaryOf(text: string, root: Node): number {
  const last = root.children?.at(-1);
  const span = last ? offsets(last) : null;
  if (!last || !span) return text.length; /* 一个块都没有(纯空白):没什么要留的 */
  return blockSettled(text, last, span) ? text.length : span[0];
}

/**
 * 「还等着后文才能成图」的那一处:`![a][r]` 在前、`[r]: path` 在后。
 *
 * 必须单独认:**定义还没到的引用式图在解析树里压根不是图片节点**,就是一段普通文字
 * (实测:`![a][r]` 无定义时整段是 text 节点)。所以 `markdownImageRefs` 看不见它,
 * 裁剪时它会被当成普通正文裁掉,定义再到也没人认领 —— 那处引用从此没有持久副本,
 * 原文件一清理就彻底没了(审查第 3 轮 R2 实测:完整正文 1 个图片节点、服务端 0 条结果)。
 *
 * 代价是误判方向:写法示例里的 `![示例]` 在代码里(围栏、行内代码)一律排掉,剩下的误判
 * (正文里真写了一段 `![foo]` 却从没有定义)只会让调用方多留一段正文,上限由调用方兜
 * (见 parsers.ts 的 PENDING_HOLD)。
 */
const PENDING_IMAGE = /!\[(?:[^\]\\]|\\[\s\S])*\](?:\[(?:[^\]\\]|\\[\s\S])*\])?/g;

/**
 * 一条**链接引用定义**(`[r]: path`)在这段正文里占的那一段。
 *
 * 为什么流式那一侧需要它:定义是**整篇文档的**,不是它所在那个块的 —— `[r]: output/x.png`
 * 写在前面、`![图][r]` 写在一万字之后,照 CommonMark 它俩就是一张图。而按块边界裁剪只能
 * 保证「块结构不被切断」,证明不了「留下来这几个块不再依赖裁走的那几个」:定义一旦被裁走,
 * 后面那处引用在解析树里连图片节点都不是,这条消息从此没有持久副本(审查第 3 轮 R2 实测:
 * 完整正文 1 处真图、服务端 0 条结果)。把等待窗口从 8 KB 放到 32 KB 也不解决 —— 那是在
 * 猜距离,而距离没有上限。所以裁剪方要把定义**带着走**(见 parsers.ts 的 keepDefinitions)。
 */
export type MarkdownDefinition = { identifier: string; start: number; end: number };

export type MarkdownScan = {
  /** 这一段正文里**渲染器真会画出来的**每一处引用(= markdownImageRefs)。 */
  refs: MarkdownImageRef[];
  /** 语法已经定型、交代到这里为止是安全的(见 stableBlockBoundary)。 */
  boundary: number;
  /** 还等着定义的那处引用所在的**顶层块起点**;没有就是 -1。 */
  pending: number;
  /** 这一段里的全部链接引用定义(见 MarkdownDefinition)。 */
  definitions: MarkdownDefinition[];
};

/** 流式那一侧要的几个答案,一次解析一起算出来(每片都来一遍,别解析好几遍)。 */
export function scanMarkdownImages(text: string): MarkdownScan {
  const root = parse(text);
  if (!root) return { refs: [], boundary: 0, pending: -1, definitions: [] };
  const refs = refsOf(root);
  const definitions: MarkdownDefinition[] = [];
  for (const node of walk(root)) {
    if (node.type !== "definition" || !node.identifier) continue;
    const span = offsets(node);
    // 块容器里的定义照样是整篇文档的(CommonMark 的定义表是文档级的),所以不分层次都收。
    if (span) definitions.push({ identifier: node.identifier, start: span[0], end: span[1] });
  }
  const blocks = root.children ?? [];
  const starts = new Set(refs.map((ref) => ref.start));
  const code: [number, number][] = [];
  for (const node of walk(root)) {
    if (node.type !== "code" && node.type !== "inlineCode") continue;
    const span = offsets(node);
    if (span) code.push(span);
  }
  let pending = -1;
  PENDING_IMAGE.lastIndex = 0;
  for (let match = PENDING_IMAGE.exec(text); match; match = PENDING_IMAGE.exec(text)) {
    const at = match.index;
    if (starts.has(at) || text[at - 1] === "\\") continue;
    if (code.some(([from, to]) => at >= from && at < to)) continue;
    pending = at;
    break;
  }
  if (pending >= 0) {
    for (const block of blocks) {
      const span = offsets(block);
      if (!span || pending < span[0] || pending >= span[1]) continue;
      pending = span[0];
      break;
    }
  }
  return { refs, boundary: boundaryOf(text, root), pending, definitions };
}
