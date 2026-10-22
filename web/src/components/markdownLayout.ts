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
   * 「执行过程」折叠块:前 `inserts` 个插入点、以及**整个排在 `offset` 之前**的顶层块
   * 收进 `render`。
   *
   * 两个数都要:切点常落在**一段之内** —— 最后一次动手的那几个事件归过程,紧跟着的正文
   * 归结论(见 turnFold 的 splitTurnSegments)。
   */
  fold?: { inserts: number; offset: number; render: (children: ReactNode) => ReactNode };
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

export function isFoldRegion(properties: Record<string, unknown> | undefined): boolean {
  return properties?.[REGION] === "fold";
}

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};

const element = (properties: Record<string, unknown>, children: HastNode[] = []): HastNode =>
  ({ type: "element", tagName: "div", properties, children });

/**
 * 把 `layout` 的插入点与折叠分组落到**这一次解析**出来的树上。
 *
 * 插入点落成一个带标记的 `div`:渲染侧的 `components.div` 认出标记后直接画那块内容
 * (标记自己不进 DOM)。折叠落成一个带标记的包装 `div`,渲染侧把 children 交给
 * `fold.render` —— 折叠块里外是同一次解析的产物,所以定义、脚注照旧全局有效。
 */
export function rehypeMarkdownLayout(layout: MarkdownLayout) {
  const foldInserts = layout.fold?.inserts ?? 0;
  const foldOffset = layout.fold ? layout.fold.offset : -1;
  return () => (tree: HastNode): void => {
    const items: { node: HastNode; folded: boolean }[] = [];
    let next = 0;
    const flush = (limit: number) => {
      while (next < layout.inserts.length && layout.inserts[next]!.offset <= limit) {
        items.push({ node: element({ [MARK]: String(next) }), folded: next < foldInserts });
        next += 1;
      }
    };
    for (const node of tree.children ?? []) {
      const start = node.position?.start?.offset;
      if (typeof start === "number") {
        flush(start);
        // 判据是「这一块**整个**在切点之前」。切点本该落在顶层块边界上(分段契约,见
        // conversationSegments 的 eventSplitAt),真落在某一块中间时宁可少折:那一块连带
        // 里面的结论留在外面 —— 「结论任何时候都不该被折起来」是硬的,多露一截过程只是
        // 不好看。
        const end = node.position?.end?.offset ?? start;
        items.push({ node, folded: end <= foldOffset });
        continue;
      }
      // 没有位置的节点有两类:`mdast-util-to-hast` 在块之间塞的换行文本(跟着上一块走),
      // 以及渲染器**生成**的整节 —— GFM 的脚注那一节恒在文末,所以剩下的插入点全排在它
      // 之前。少了后一档,脚注一出现就会把所有执行步骤挤到文档开头。
      if (node.type === "element") flush(Number.POSITIVE_INFINITY);
      items.push({ node, folded: node.type !== "element" && (items.at(-1)?.folded ?? false) });
    }
    flush(Number.POSITIVE_INFINITY);

    const folded = items.filter((item) => item.folded).map((item) => item.node);
    const rest = items.filter((item) => !item.folded).map((item) => item.node);
    tree.children = folded.length ? [element({ [REGION]: "fold" }, folded), ...rest] : rest;
  };
}
