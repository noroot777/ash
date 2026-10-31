/**
 * 从一段会话选区里取出「用户真正想要的那段话」—— 跨消息选中时，中间夹着的执行过程、
 * 身份头、账目尾栏都不算。
 *
 * 判据两条，先后顺序要紧：
 *
 * 1. **先读 HTML 语义**。`header` / `footer` / `summary` / `button` / `time` /
 *    `aria-hidden` 这些标签已经把「我是界面装置、不是正文」说清楚了，不必再逐处加标记
 *    —— 靠人工逐处标记的黑名单漏一处就带一处噪音，而漏在哪儿只能等下一次被用户发现。
 * 2. **语义说不出来的才声明**。`data-selection-chrome` = 整块不算正文（现有两处：展开
 *    后的执行事件行是一堆普通 div；过程折叠里关着的那半截本来就是正文，分不出来）。
 *    `data-selection-content` = 装置**里头**这一块其实是正文（折起来时摘要行就是整张卡
 *    的全部可见内容，整块删掉等于用户什么都没选到）。
 *
 * 另有两条不是判据的硬约束：
 *
 * - **排版文本只许问浏览器要**。`Range.toString()` 把文本节点首尾相接、一个换行都不给；
 *   离屏克隆读 `innerText` 又脱离了祖先链，`.task-user-bubble > p` 这种祖先限定的
 *   `white-space` 当场失效，多行用户消息被折成一行。所以只能在**原文档上**借
 *   `window.getSelection()` 把每一截框出来读 `toString()`；借了就得精确还原（见
 *   borrowSelection），否则用户正拖着的那一下会被清掉。
 * - **只认看得见的东西**。闭合 `<details>` 里的文字 `Range.toString()` 照样读得到，而拿
 *   含隐藏内容的 range 重建 Selection 之后，`Selection.toString()` 甚至会越过 range 边界
 *   把后面的字一起带出来（实测能带出尾栏上的「复制答案」）。所以没有布局盒子的子树一律
 *   当装置剔掉，重建出来的每一截都只盖着原选区里看得见的正文。
 *
 * 已知代价：`button` 一刀切会连带剔掉**待答提问卡上的候选项**（那些选项是按钮）。要选它
 * 们得单独选一次（整段落在装置里时原样给）。
 */

/** 语义上就是界面装置的那些标签，外加一处说不出来、只能声明的。 */
const CHROME = 'header,footer,summary,button,[role="button"],time,[aria-hidden="true"],[data-selection-chrome]';
/** 装置里头这一块其实是正文。 */
const CONTENT = "[data-selection-content]";

/** 取出这段选区里的正文，按它在页面上的排版。剔干净之后什么都不剩就给空串。 */
export function selectionContentText(range: Range, root: Element): string {
  const parts = contentRanges(range, root);
  const selection = window.getSelection();
  // 拿不到选区就只能退回文本节点拼接：没有块级换行，但比什么都没有好。
  if (!selection) return join(parts.map((part) => part.toString()));
  return borrowSelection(selection, () => join(parts.map((part) => renderedText(part, selection))));
}

const join = (texts: string[]) => texts.map(trimSeam).filter(Boolean).join("\n\n");

/** 把选区按「要剔掉的那些段」切成若干截。没有要剔的就是它自己。 */
function contentRanges(range: Range, root: Element): Range[] {
  const skips = skipRanges(range, root);
  if (!skips.length) return [range.cloneRange()];
  const parts: Range[] = [];
  let rest: Range | null = range.cloneRange();
  for (const skip of skips) {
    if (!rest) break;
    // 这一段已经整个落在选区后头了 —— 跳过区按文档顺序排，后面的只会更远，收手。不拦住
    // 的话底下那个 setEnd 会把这一截的尾巴推到选区外面去（选到一半的那块装置后面还有
    // 字时，取文就会多带出用户没选的内容）。
    if (startsAfter(rest, skip)) break;
    const head = rest.cloneRange();
    // 要剔的那段压在选区头上(或尾上)时，setEnd/setStart 会把另一头一起拖过来 ——
    // 于是这一截自己就塌成空的，正是想要的结果，不必另外判一遍前后关系。
    head.setEnd(skip.startContainer, skip.startOffset);
    if (!head.collapsed) parts.push(head);
    rest.setStart(skip.endContainer, skip.endOffset);
    if (rest.collapsed) rest = null;
  }
  if (rest) parts.push(rest);
  return parts;
}

/** 这一段是不是整个排在选区后头。比不了（节点已经不在同一棵树上）就当是，宁可少剔。 */
function startsAfter(rest: Range, skip: Range): boolean {
  try {
    return rest.comparePoint(skip.startContainer, skip.startOffset) > 0;
  } catch {
    return true;
  }
}

/**
 * 选区里要剔掉的那些段，按文档顺序、互不重叠。
 *
 * 返回的是 Range 而不是元素：装置里头可能包着正文（折起来时的摘要行），那一块要原样
 * 留下 —— 于是一块装置被它内部的正文岛切成好几段。
 */
function skipRanges(range: Range, root: Element): Range[] {
  const anchor = elementOf(range.commonAncestorContainer);
  if (!anchor || !root.contains(anchor)) return [];
  // 整段选区都落在一块装置里：那就是用户专门去选它，原样给。
  const enclosing = anchor.closest(CHROME);
  if (enclosing && root.contains(enclosing)) return [];
  const outer: Element[] = [];
  const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => {
      // 没碰到选区的整棵子树直接剪掉：开销跟选区多大成正比，跟会话多长无关。
      if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
      return isChrome(node as Element) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  while (walker.nextNode()) {
    const element = walker.currentNode as Element;
    // 外层已经整块剔掉了，嵌在里面的不必再算一遍。
    if (!outer.some((taken) => taken.contains(element))) outer.push(element);
  }
  return outer.flatMap(skipOf);
}

/** 要整块剔掉的：语义上的界面装置，或者此刻根本看不见。 */
function isChrome(element: Element): boolean {
  if (element.matches(CHROME)) return true;
  // 空元素不判可见性 —— 它没字可剔，剔了反而把一行正文切成两截，拼回去多一个空行。
  return !!element.textContent?.trim() && !isVisible(element);
}

/**
 * 此刻真画得出来。不能拿 `getClientRects()` 判 —— 闭合 `<details>` 里关着的那半截照旧
 * 有布局盒子（实测 788×159、`offsetHeight` 159），只有 `checkVisibility()` 认得出它是被
 * `content-visibility` 跳过的。
 *
 * 为什么非判不可：`Range.toString()` 读得到关着的那段问答，底下拿不到 `Selection` 时走
 * 的就是它；而借 `Selection` 读的那条路上，拿含隐藏内容的 range 重建选区之后，浏览器
 * 返回的东西连 range 边界都未必认（审查实测过一次把后面尾栏的字一起带出来，本机 Chrome
 * 上则是直接给空串）。两种都不是「原选区里看得见的那部分」，所以隐藏子树一律先剔掉。
 */
const isVisible = (element: Element) => element.checkVisibility();

/**
 * 一块装置要让出的那些段。里头声明了正文就被切开：只有装置自己那几截进跳过区，正文岛
 * 原样留着。
 */
function skipOf(element: Element): Range[] {
  const whole = document.createRange();
  whole.selectNode(element);
  const islands = contentIslands(element);
  if (!islands.length) return [whole];
  const parts: Range[] = [];
  const rest = whole;
  for (const island of islands) {
    const head = rest.cloneRange();
    head.setEndBefore(island);
    if (!head.collapsed) parts.push(head);
    rest.setStartAfter(island);
  }
  if (!rest.collapsed) parts.push(rest);
  return parts;
}

/** 这块装置里最外层的那几座正文岛（文档顺序）。 */
function contentIslands(element: Element): Element[] {
  const found: Element[] = [];
  for (const island of element.querySelectorAll(CONTENT)) {
    // 岛自己也看不见（展开之后让位的那半行）就不算正文，留着它只会把隐藏文字带出来。
    if (!isVisible(island)) continue;
    if (found.some((taken) => taken.contains(island))) continue;
    found.push(island);
  }
  return found;
}

const elementOf = (node: Node): Element | null => (node instanceof Element ? node : node.parentElement);

/** 切口处的空白不算正文，但行内的缩进要留着（代码块靠它）。 */
function trimSeam(text: string): string {
  return text.replace(/^(?:[ \t]*[\r\n])+/, "").replace(/(?:[\r\n][ \t]*)+$/, "");
}

/**
 * 借当前文档的选区去读排版文本，读完精确还原（anchor / focus 各自归位，方向也不翻）。
 * 还原不精确的话，拖选到一半的那一下会被打断。
 */
function borrowSelection(selection: Selection, read: () => string): string {
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  try {
    return read();
  } finally {
    if (anchorNode && focusNode) selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
    else selection.removeAllRanges();
  }
}

function renderedText(range: Range, selection: Selection): string {
  selection.removeAllRanges();
  selection.addRange(range);
  return selection.toString();
}
