// 执行步骤怎么摆进正文里 —— **一条消息只解析一次**,步骤按节点偏移插进去。
//
// 为什么必须这样:Markdown 的定义是**整篇文档的**,不是某一块的。链接引用定义
// (`[r]: path`)、脚注定义都可以写在离引用它的那句话一万字远的地方,照 CommonMark 它们
// 就是一张图、一条脚注。所以「把正文按执行事件切成几段、每段各自过一遍渲染器」这件事
// 从根上做不对:
//   · 脚注引用在前一段、脚注定义在后一段 —— 前一段没有定义,后一段没有引用它的正文,
//     两段谁都画不出那张图。整条正文完整渲染则有 1 张(审查第 3 轮 R2 实测:
//     footnoteAgentImages=0 / fullFootnoteImages=1,而附件卡片已经被认领走了,于是页面上
//     0 图 0 卡片);
//   · 把切点挪到「顶层块边界」只能保证块结构不被切断 —— 块是**结构**单位,定义的作用域
//     是**文档**。两者不是同一件事,所以那条判据证明不了「这两段互不依赖」。
//
// 结论:解析一次,然后按**节点的源码偏移**把执行步骤插进顶层块之间。折叠(执行过程)也在
// 这同一棵树里完成 —— 它是展示分组,不是另一份文档,所以用一个包装节点圈住前面那几个块,
// 而不是另起一次渲染。
import type { ReactNode } from "react";

/** 插在整条正文某个偏移处的一块非 Markdown 内容(执行步骤 + 这一步的附件卡片)。 */
export type MarkdownInsert = {
  /**
   * 排在「正文偏移 ≥ 它」的第一个顶层块**之前**。
   *
   * 落在某个块中间时排在那一块**之后**(下一个块之前)—— 一块正文不会被劈开。调用方把
   * 偏移对齐到块边界上就没有这种情况(见 conversationSegments 的 eventSplitAt)。
   */
  offset: number;
  node: ReactNode;
};

export type MarkdownLayout = {
  /** 按 `offset` 升序。 */
  inserts: MarkdownInsert[];
  /**
   * 正文按**源码顺序**分成的几个区 —— 折叠就是其中带 `render` 的那几个。
   *
   * 为什么是「分区」而不是「几份文档」:折叠、分栏都只是**展示分组**,而定义、脚注的作用域
   * 是整篇文档。各自过一遍渲染器那一版,结论里引用明细里的图片定义/脚注两头落空:明细那
   * 一份没有引用它的正文,结论那一份没有定义,于是点开「展开完整报告」照样 0 张图、脚注
   * 一节都不建(审查第 4 轮 R2 实测;同一份内容整篇交给渲染器是 2 张图)。所以整篇只解析
   * 一次,这里只按偏移把顶层块分到各区去。
   *
   * 按声明顺序首尾相接:`until` 升序,每个顶层块归**第一个「整块都在它 `until` 之前」**
   * 的区;一个块都不归的(以及渲染器生成的脚注那一节)排在全部区之后、原样铺开。
   */
  regions?: MarkdownRegion[];
};

export type MarkdownRegion = {
  /**
   * 这一区到哪儿为止(正文偏移)。**整块**都在它之前的顶层块归这一区;最后一区常给
   * `Number.POSITIVE_INFINITY`(「剩下的全归我」)。
   *
   * 切点落在某一块中间时,那一块归**后面**那一区 —— 判据是「这一块整个在切点之前」。
   * 对过程折叠来说就是宁可少折:那一块连带里面的结论留在外面(「结论任何时候都不该被折
   * 起来」是硬的,多露一截过程只是不好看)。调用方把偏移对齐到块边界上就没有这种情况。
   */
  until: number;
  /**
   * 插入点下标的**上界**:`< inserts` 的那几个插入点归这一区(升序,跨区累计)。
   *
   * 两个数都要:切点常落在**一段之内** —— 最后一次动手的那几个事件归过程,紧跟着的正文
   * 归结论(见 turnFold 的 splitTurnSegments)。报告分栏那一路没有插入点,不传。
   */
  inserts?: number;
  /** 这一区的内容怎么画(折叠就在这儿套 `<details>`);不给就原样铺开。 */
  render?: (children: ReactNode) => ReactNode;
  /**
   * 这一区**此刻没有呈现给用户**(折起来了)。
   *
   * 只影响渲染器**生成**的那一节(GFM 的脚注):脚注正文恒在文末、在所有区之外,于是
   * 「只被折叠里的正文引用到的那条脚注」会连同它里面的截图一起露在外面 —— 技术明细明明
   * 收着,它的证据已经摊在屏幕上了(审查第 5 轮 N1)。有了这个标记,就能按**当前看得见的
   * 引用**决定哪几条脚注该画。
   */
  collapsed?: boolean;
};

const MARK = "dataAshInsert";
const REGION = "dataAshRegion";

/** 这个 hast 节点是我们插的标记吗 —— 是就返回它在 `inserts` 里的下标。 */
export function insertIndexOf(properties: Record<string, unknown> | undefined): number | null {
  const raw = properties?.[MARK];
  if (typeof raw !== "string") return null;
  const index = Number(raw);
  return Number.isInteger(index) ? index : null;
}

/** 这个 hast 节点是某一区的包装吗 —— 是就返回它在 `regions` 里的下标。 */
export function regionIndexOf(properties: Record<string, unknown> | undefined): number | null {
  const raw = properties?.[REGION];
  if (typeof raw !== "string") return null;
  const index = Number(raw);
  return Number.isInteger(index) ? index : null;
}

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};

// GFM 生成的脚注:`<section data-footnotes>` 里一个 `<ol>`,每条 `<li id="user-content-fn-x">`,
// 正文里的引用是 `<a href="#user-content-fn-x">`。两头都按这个前缀认。
const FOOTNOTE = "user-content-fn-";
const isFootnoteSection = (node: HastNode) =>
  node.type === "element" && node.tagName === "section" && node.properties?.dataFootnotes !== undefined;

/** 这棵子树里引用到的脚注。 */
function footnoteRefs(node: HastNode, into: Set<string>): Set<string> {
  const href = node.tagName === "a" ? node.properties?.href : undefined;
  if (typeof href === "string" && href.startsWith(`#${FOOTNOTE}`)) into.add(href.slice(FOOTNOTE.length + 1));
  for (const child of node.children ?? []) footnoteRefs(child, into);
  return into;
}

/**
 * 只留**当前看得见的引用**够得着的那几条脚注。
 *
 * 可达性照渲染器自己那套算:脚注正文里还能再引用别的脚注,所以要做一次闭包。留下来的那几条
 * 把原来的序号钉在 `value` 上 —— 中间少一条就让 `<ol>` 自己重新数的话,正文里的角标和底下
 * 的编号会对不上。一条都不剩时整节都不画(标题孤零零留着更难看)。
 */
function pruneFootnotes(section: HastNode, visible: Set<string>): boolean {
  const list = (section.children ?? []).find((node) => node.tagName === "ol");
  if (!list) return true;
  const items = (list.children ?? []).filter((node) => node.tagName === "li");
  const idOf = (node: HastNode) => {
    const id = node.properties?.id;
    return typeof id === "string" && id.startsWith(FOOTNOTE) ? id.slice(FOOTNOTE.length) : null;
  };
  const kept = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const item of items) {
      const id = idOf(item);
      if (!id || kept.has(id) || !visible.has(id)) continue;
      kept.add(id);
      footnoteRefs(item, visible);
      grew = true;
    }
  }
  list.children = (list.children ?? []).filter((node) => {
    const id = node.tagName === "li" ? idOf(node) : null;
    return id === null || kept.has(id);
  });
  for (const [index, item] of items.entries()) {
    if (idOf(item) && kept.has(idOf(item)!)) item.properties = { ...item.properties, value: index + 1 };
  }
  return kept.size > 0;
}

const element = (properties: Record<string, unknown>, children: HastNode[] = []): HastNode =>
  ({ type: "element", tagName: "div", properties, children });

/**
 * 把 `layout` 的插入点与分区落到**这一次解析**出来的树上。
 *
 * 插入点落成一个带标记的 `div`:渲染侧的 `components.div` 认出标记后直接画那块内容
 * (标记自己不进 DOM)。带 `render` 的区落成一个带标记的包装 `div`,渲染侧把 children 交给
 * 那个区的 `render` —— 区里区外是同一次解析的产物,所以定义、脚注照旧全局有效。
 */
export function rehypeMarkdownLayout(layout: MarkdownLayout) {
  const regions = layout.regions ?? [];
  // 一个块都不归的排在最后、原样铺开(下标 = 区的个数)。
  const REST = regions.length;
  const regionOfBlock = (end: number) => {
    const at = regions.findIndex((region) => end <= region.until);
    return at < 0 ? REST : at;
  };
  const regionOfInsert = (index: number) => {
    const at = regions.findIndex((region) => index < (region.inserts ?? 0));
    return at < 0 ? REST : at;
  };
  return () => (tree: HastNode): void => {
    const items: { node: HastNode; region: number }[] = [];
    let next = 0;
    const flush = (limit: number) => {
      while (next < layout.inserts.length && layout.inserts[next]!.offset <= limit) {
        items.push({ node: element({ [MARK]: String(next) }), region: regionOfInsert(next) });
        next += 1;
      }
    };
    for (const node of tree.children ?? []) {
      const start = node.position?.start?.offset;
      if (typeof start === "number") {
        flush(start);
        items.push({ node, region: regionOfBlock(node.position?.end?.offset ?? start) });
        continue;
      }
      // 没有位置的节点有两类:`mdast-util-to-hast` 在块之间塞的换行文本(跟着上一块走),
      // 以及渲染器**生成**的整节 —— GFM 的脚注那一节恒在文末,所以剩下的插入点全排在它
      // 之前。少了后一档,脚注一出现就会把所有执行步骤挤到文档开头。生成的那一节一律排在
      // 全部区之外:它是整篇文档的产物,折起来就等于「脚注正文看不见」。
      if (node.type === "element") flush(Number.POSITIVE_INFINITY);
      items.push({ node, region: node.type === "element" ? REST : (items.at(-1)?.region ?? REST) });
    }
    flush(Number.POSITIVE_INFINITY);

    // 折起来的那几区不呈现,它们里面的引用也就不算「看得见」—— 只被它们引用到的脚注跟着
    // 不画(连同脚注里的截图)。一条都没折时这一整段不跑,解析结果一个字节都不动。
    if (regions.some((region) => region.collapsed)) {
      const visible = new Set<string>();
      for (const item of items) {
        if (regions[item.region]?.collapsed || isFootnoteSection(item.node)) continue;
        footnoteRefs(item.node, visible);
      }
      for (const item of [...items]) {
        if (!isFootnoteSection(item.node) || pruneFootnotes(item.node, visible)) continue;
        items.splice(items.indexOf(item), 1);
      }
    }

    const children: HastNode[] = [];
    for (const [index, region] of regions.entries()) {
      const own = items.filter((item) => item.region === index).map((item) => item.node);
      if (!own.length) continue;
      // 不给 `render` 的区原样铺开:包一层 div 会多出一个块级盒子,间距、`:first-child`
      // 这类选择器全跟着变。
      children.push(...(region.render ? [element({ [REGION]: String(index) }, own)] : own));
    }
    children.push(...items.filter((item) => item.region === REST).map((item) => item.node));
    tree.children = children;
  };
}
