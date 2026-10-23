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
import { normalizeIdentifier } from "micromark-util-normalize-identifier";

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
   * 引用式图(`![图][r]`)的标识符,已按 CommonMark 归一;行内图没有这个字段。
   *
   * 流式那一侧要它:**定义表是整篇文档的,而流式只重解析最后一个窗口**。窗口里恰好另有
   * 一条同名定义时,这一窗的解析会按那条解(CommonMark 其实取全篇**第一条**),于是字节
   * 按错的目的地冻结。带上标识符,调用方才能拿自己那张全篇定义表把目的地改回来。
   */
  identifier?: string;
  /**
   * 渲染器真会把它画出来吗。
   *
   * 为假的只有一类:它住在一条**渲染器走不到**的脚注定义里。脚注那一节是渲染器按正文里
   * 的引用**建出来的**(mdast-util-to-hast,见 reachableFootnotes),走不到的定义整节被
   * 丢掉 —— 解析树里它是货真价实的图片节点,屏幕上一个像素都没有。三种形态:没人引用、
   * 只被另一条走不到的定义引用(含自引)、同名定义里排第二的那一份。
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

/** 目的地里属于路径的那一段到哪儿为止:查询(`?`)与片段(`#`)都不是路径的一部分。 */
const QUERY_BOUNDARY = /[?#]/;

/**
 * 一处目的地所指本机文件的**路径成分** —— 保存端、展示端、工作目录 resolver 共用的唯一口径。
 *
 * 必要性:各自切一次的那一版两头解释不一致。`![](output/shot.svg?v=1)` 展示端先切掉 `?v=1`
 * 再解码,去工作目录取得到;保存端把整串当文件名,于是 `extname` 得到 `.svg?v=1` 一类不在
 * 类型表里的后缀,压根不读文件也不留副本 —— 当时看得见,原文件一清理就永久没了,而且那条
 * 结果既没有 path 也没有 lost,事后看不出是「没存成」(审查第 4 轮 R4)。出路只能是共用一份
 * 契约:扩大后缀表是把分隔符当文件名的一部分认下来,「下一次再读」则赌文件还在。
 *
 * **先切后解码**,顺序不能反:`%3F`/`%23` 是文件名里真的那个字符,先解码会把它们当成分隔符
 * 切掉。裸写的 `?`/`#` 在 CommonMark 里确实算目的地的一部分,但浏览器、`URL` 和本应用的路由
 * 三家都按分隔符解释,所以按分隔符处置才跟「屏幕上画出来的是哪张图」一致。
 *
 * 解不开的转义(`%ZZ`)**原样留着**:那串是不是合法文件名、有没有爬出根,权威在读取端的门禁
 * (服务端 `resolveInRoot` + realpath),不在这里的字符串形状。
 *
 * 只回答「路径是哪一段」,不判绝对/相对、不判是不是本机地址(那是 isNetworkDestination 与各
 * 调用点的根判据),所以给网址传进来也只会得到一段无意义的字符串 —— 调用点必须先问那一问。
 */
export function destinationFilePath(destination: string): string {
  const raw = destination.trim();
  const boundary = raw.search(QUERY_BOUNDARY);
  const path = boundary < 0 ? raw : raw.slice(0, boundary);
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
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

/**
 * 渲染器建脚注那一节时**真正会走到**的那几条定义。
 *
 * 口径照抄 `mdast-util-to-hast`:它不遍历「树里所有定义」,而是从**正文里的引用**出发,
 * 每个标识符只取同名的**第一条**定义,再把那条定义内容里的引用接着排进队列(所以链式
 * 引用算可达)。两处差别都出过错(审查第 4 轮 R3):
 *   · 「全树里出现过这个标识符的引用」≠「正文到得了」—— 没人引用的脚注 A 在自己内容里
 *     引用 B(或者自引),两节渲染器一节都不建,可按前一种判据 B 被当成会画出来,于是卡片
 *     被认领走、屏幕上一个像素都没有;
 *   · 同名定义有两份时渲染器只用第一份,按前一种判据两份里的图都算「会画」,第二份对应的
 *     那张附件就被白白撤掉。
 */
function reachableFootnotes(root: Node): Set<Node> {
  const first = new Map<string, Node>();
  /** 这条定义的内容里引用了谁(可达之后要接着排队)。 */
  const nested = new Map<Node, string[]>();
  /** 正文(不在任何定义里)引用了谁 —— 可达性的起点。 */
  const body: string[] = [];
  const visit = (node: Node, owner: Node | null): void => {
    let scope = owner;
    if (node.type === "footnoteDefinition") {
      const identifier = node.identifier ?? "";
      if (!first.has(identifier)) first.set(identifier, node);
      scope = node; /* 它的子树归它:**最内层**那条定义才是这些节点的归属 */
    } else if (node.type === "footnoteReference" && node.identifier) {
      if (owner) nested.set(owner, [...(nested.get(owner) ?? []), node.identifier]);
      else body.push(node.identifier);
    }
    for (const child of node.children ?? []) visit(child, scope);
  };
  visit(root, null);
  const reachable = new Set<Node>();
  const queue = [...body];
  while (queue.length) {
    const definition = first.get(queue.shift()!);
    if (!definition || reachable.has(definition)) continue;
    reachable.add(definition);
    queue.push(...(nested.get(definition) ?? []));
  }
  return reachable;
}

function refsOf(root: Node): MarkdownImageRef[] {
  const definitions = new Map<string, string>();
  for (const node of walk(root)) {
    if (node.type !== "definition" || !node.identifier || typeof node.url !== "string") continue;
    // 同名定义:CommonMark 取**第一条**。
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  }
  const reachable = reachableFootnotes(root);
  const refs: MarkdownImageRef[] = [];
  /** 一处引用住在**最内层**的那条脚注定义里(没有就是正文)。 */
  const collect = (node: Node, owner: Node | null): void => {
    const scope = node.type === "footnoteDefinition" ? node : owner;
    const inline = node.type === "image";
    if (inline || node.type === "imageReference") {
      const span = offsets(node);
      const destination = (inline ? node.url : definitions.get(node.identifier ?? ""))?.trim();
      if (span && destination) {
        refs.push({
          destination,
          start: span[0],
          end: span[1],
          rewrite: rewriter(node.alt ?? ""),
          rendered: !scope || reachable.has(scope),
          ...(inline ? {} : { identifier: node.identifier }),
        });
      }
    }
    for (const child of node.children ?? []) collect(child, scope);
  };
  collect(root, null);
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
 * (实测:`![a][r]` 无定义时整段是 text 节点)。所以 `markdownImageRefs` 看不见它 ——
 * 保存端据此知道「这里将来可能冒出一张图」:它那几处的字节还没法冻结,后面那些引用
 * 也不能先交代出去(交代了,这一处将来插在中间就让整列配对错位)。
 *
 * 两个捕获组 = alt 与标签:`![a][r]` 取 `r`,`![a][]`(折叠式)与 `![a]`(简写式)取 `a`,
 * 跟 CommonMark 一致。拿到标签才能在定义真的到达时**认回是哪一处**在等它。
 *
 * 代价是误判方向:写法示例里的 `![示例]` 在代码里(围栏、行内代码)一律排掉,剩下的误判
 * (正文里真写了一段 `![foo]` 却从没有定义)只会让这一处之后的交代推迟到文档收尾。
 */
const PENDING_IMAGE = /!\[((?:[^\]\\]|\\[\s\S])*)\](?:\[((?:[^\]\\]|\\[\s\S])*)\])?/g;

/**
 * 一条**链接引用定义**(`[r]: path`)在这段正文里占的那一段。
 *
 * 为什么流式那一侧需要它:定义是**整篇文档的**,不是它所在那个块的 —— `[r]: output/x.png`
 * 写在前面、`![图][r]` 写在一万字之后,照 CommonMark 它俩就是一张图。而流式只重解析最后
 * 一个窗口:定义一出窗口,后面那处引用在这一窗的解析树里连图片节点都不是(审查第 3 轮 R2
 * 实测:完整正文 1 处真图、服务端 0 条结果)。
 *
 * 曾经的出路是把定义**重写成一行源码带着走**,而它必然要猜一个预算 —— 600 条定义就溢出,
 * 后面的引用照旧拍不到字节(审查第 6 轮 R2 第 2 行);标识符的转义也在重写里栽过
 * (第 5 轮 R2B)。所以现在反过来:保存端拿这几条**攒一张整篇的定义表**(identifier →
 * 目的地,同名取第一条),再配 `MarkdownWaitingRef` 认回在等它的那几处引用。没有预算,
 * 也不必重写源码。
 */
export type MarkdownDefinition = {
  identifier: string;
  start: number;
  end: number;
  /** 这条定义指到哪儿(解析树给的目的地,已经解过转义与折行)。 */
  destination: string;
  /**
   * 这条定义**写完了吗** —— 它的源码后面还有别的字(或者正文以换行收尾)才算写完。
   *
   * 定义行是流式正文里唯一「目的地由裸文字收尾」的构造:`[r]: partial.svg` 这一刻解析
   * 出来是一条完整定义,下一片补个 `?v=1` 它就变成另一个目的地。没写完的定义只配用来
   * **提前冻结字节**(目的地多半已经完整,猜错的代价只是多一份没人认领的拷贝);把它当
   * 真的收进定义表、据它交代引用,等后文把目的地改掉,已交代的来源就跟整篇正文对不上
   * (审查第 7 轮 R2:正文指向 `partial.svg?v=1`,交代出去的却是 `partial.svg`,前端
   * 对不上记录只好退回工作目录,画出重拍后的新图)。
   */
  terminated: boolean;
};

export type MarkdownScan = {
  /** 这一段正文里**渲染器真会画出来的**每一处引用(= markdownImageRefs)。 */
  refs: MarkdownImageRef[];
  /** 语法已经定型、交代到这里为止是安全的(见 stableBlockBoundary)。 */
  boundary: number;
  /** 还等着定义的那处引用所在的**顶层块起点**;没有就是 -1。 */
  pending: number;
  /** 这一段里的全部链接引用定义(见 MarkdownDefinition)。 */
  definitions: MarkdownDefinition[];
  /** 还等着定义的**每一处**候选引用,按出现顺序(见 PENDING_IMAGE 与 MarkdownWaitingRef)。 */
  waiting: MarkdownWaitingRef[];
};

/**
 * 一处**还没拿到定义**的引用式图候选。
 *
 * `identifier` 跟 `MarkdownDefinition.identifier`、`MarkdownImageRef.identifier` 是同一套
 * 归一口径(照抄 mdast:空白折叠 + 大小写折叠,源码里的反斜杠转义原样留着),所以定义一到
 * 就能直接按它查表 —— 不必再把定义重写成一行源码带着走(那条路在标识符的转义上栽过:
 * `[a\*b]` 再转义一遍就跟 `![图][a\*b]` 对不上,审查第 5 轮 R2B)。
 */
export type MarkdownWaitingRef = { identifier: string; start: number; end: number };

/** 流式那一侧要的几个答案,一次解析一起算出来(每片都来一遍,别解析好几遍)。 */
export function scanMarkdownImages(text: string): MarkdownScan {
  const root = parse(text);
  if (!root) return { refs: [], boundary: 0, pending: -1, definitions: [], waiting: [] };
  const refs = refsOf(root);
  const definitions: MarkdownDefinition[] = [];
  for (const node of walk(root)) {
    if (node.type !== "definition" || !node.identifier) continue;
    const span = offsets(node);
    // 块容器里的定义照样是整篇文档的(CommonMark 的定义表是文档级的),所以不分层次都收。
    if (span) {
      definitions.push({
        identifier: node.identifier,
        start: span[0],
        end: span[1],
        destination: node.url ?? "",
        terminated: span[1] < text.length || /\n$/.test(text),
      });
    }
  }
  const blocks = root.children ?? [];
  const starts = new Set(refs.map((ref) => ref.start));
  const code: [number, number][] = [];
  for (const node of walk(root)) {
    if (node.type !== "code" && node.type !== "inlineCode") continue;
    const span = offsets(node);
    if (span) code.push(span);
  }
  const waiting: MarkdownWaitingRef[] = [];
  PENDING_IMAGE.lastIndex = 0;
  for (let match = PENDING_IMAGE.exec(text); match; match = PENDING_IMAGE.exec(text)) {
    const at = match.index;
    if (starts.has(at) || text[at - 1] === "\\") continue;
    if (code.some(([from, to]) => at >= from && at < to)) continue;
    // 标签:完整式取第二组,折叠式(`![a][]`)与简写式(`![a]`)取 alt 那一组。
    const label = match[2]?.trim() ? match[2] : match[1] ?? "";
    waiting.push({ identifier: normalizeIdentifier(label).toLowerCase(), start: at, end: at + match[0].length });
  }
  let pending = waiting.length ? waiting[0]!.start : -1;
  if (pending >= 0) {
    for (const block of blocks) {
      const span = offsets(block);
      if (!span || pending < span[0] || pending >= span[1]) continue;
      pending = span[0];
      break;
    }
  }
  return { refs, boundary: boundaryOf(text, root), pending, definitions, waiting };
}
