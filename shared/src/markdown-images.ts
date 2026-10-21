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
  if (!root) return [];
  const definitions = new Map<string, string>();
  for (const node of walk(root)) {
    if (node.type !== "definition" || !node.identifier || typeof node.url !== "string") continue;
    // 同名定义:CommonMark 取**第一条**。
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  }
  const refs: MarkdownImageRef[] = [];
  for (const node of walk(root)) {
    const inline = node.type === "image";
    if (!inline && node.type !== "imageReference") continue;
    const span = offsets(node);
    if (!span) continue;
    const destination = (inline ? node.url : definitions.get(node.identifier ?? ""))?.trim();
    if (!destination) continue;
    refs.push({ destination, start: span[0], end: span[1], rewrite: rewriter(node.alt ?? "") });
  }
  return refs.sort((a, b) => a.start - b.start);
}

/** 最后一个顶层块的起点 —— 未闭合的围栏恒是最后一个块,所以裁到这里不会把开栏丢掉。 */
function lastBlockStart(text: string): number {
  const root = parse(text);
  const last = root?.children?.at(-1);
  return (last && offsets(last)?.[0]) ?? 0;
}

/**
 * 流式扫描攒的那段文本太长了,从哪儿往后留着。
 *
 * 必要性:流式解析器一个 text 事件可能只是半句话,得攒一段再扫;攒长了得裁。按字符数硬裁
 * 会把**块的状态**裁断 —— 开栏的 ``` 被裁掉之后,围栏里的写法示例就被当成真图存一份
 * (多一张卡片;正文那边照旧不认它,因为展示端扫的是完整正文)。
 *
 * 所以按**顶层块边界**裁:未闭合的围栏恒是最后一个块,裁到它的起点等于把开栏一起留着。
 * 一个块自己就超了上限(往围栏里灌一整份日志)时留它的首行加尾部 —— 丢内容、留状态。
 * 裁到上限的一半,好让下一次裁剪隔开一段距离:每次裁剪都要解析一遍,贴着上限裁会变成
 * 每来一片就解析一次。
 */
export function trimCarry(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(1, Math.floor(max / 2));
  const block = lastBlockStart(text);
  if (text.length - block <= keep) return text.slice(block);
  const lineEnd = text.indexOf("\n", block);
  const head = lineEnd < 0 ? "" : text.slice(block, lineEnd + 1);
  return head + text.slice(-keep);
}
