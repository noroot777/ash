import { motionReduced } from "../lib/useSwapText.ts";
import { highlightTerms } from "./searchTerms.ts";
import "../styles/search-reveal.css";

/**
 * ⌘K 打开一条正文 / 会话命中时，会话直接落到命中的那一处，并把关键词闪几下。
 *
 * 面板打开任务和会话画出来之间隔着「切任务 → 读会话 → 渲染」，所以这里只是挂一张**待办**：
 * 面板记下「哪个任务、找哪些词、服务端给的那段上下文」，会话那边（useSearchReveal）
 * 等正文读完、在自己的 DOM 里真的找到了词再落地，用掉即清。
 *
 * 在 DOM 上找而不是拿服务端给的偏移：服务端搜的是原始语料（markdown 源文、落盘的 jsonl），
 * 屏幕上的是渲染后的文字 —— 两边的偏移对不上，词却是同一个词。
 */
export type SearchRevealRequest = {
  taskId: string;
  terms: string[];
  /** 命中那一段的上下文（服务端的 snippet）。同一个词出现好几次时，靠它认出是哪一处。 */
  hint: string;
  expires: number;
};

/** 打开后多久还没找到就作罢：会话读不出来、或者词只在不上屏的执行轨迹里。 */
const REQUEST_TTL_MS = 15_000;

let pending: SearchRevealRequest | null = null;
const listeners = new Set<() => void>();

export function requestSearchReveal(taskId: string, query: string, hint: string) {
  // 上一次还在闪的就此收掉：人已经去找下一处了，那几处的亮灭只会让他看错地方。
  clearFlash();
  const terms = highlightTerms(query);
  pending = terms.length ? { taskId, terms, hint, expires: Date.now() + REQUEST_TTL_MS } : null;
  listeners.forEach((listener) => listener());
}

export function pendingSearchReveal(taskId: string): SearchRevealRequest | null {
  if (pending && pending.expires <= Date.now()) pending = null;
  return pending?.taskId === taskId ? pending : null;
}

export function settleSearchReveal(request: SearchRevealRequest) {
  if (pending === request) pending = null;
}

/**
 * 读者自己挪了这条会话（滚轮、触控、方向键、拖滚动条、导航条跳转、回顶回底）：这个任务的待办
 * 作废。由贴底逻辑那个统一的「读者接手」入口调（useStickToBottom 的 onReaderMove），所以
 * 会话还没读完、待办还没开始找的那几秒里也算数 —— 等读完了再落，就是把已经接手的人拽走。
 */
export function abandonSearchReveal(taskId: string) {
  if (pending?.taskId !== taskId) return;
  pending = null;
  listeners.forEach((listener) => listener());
}

export function subscribeSearchReveal(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

type Occurrence = {
  range: Range;
  term: string;
  /** 在拼起来的全文里的位置，比上下文用。 */
  start: number;
  end: number;
  /** 关着的折叠块（执行过程）：词在里面，得先打开才看得见。空 = 现在就看得见。 */
  closed: HTMLDetailsElement[];
};

// 按钮上的字、输入框、读屏专用的那些不是会话内容；`data-search-skip` 标的是同一段正文的
// 缩略副本（duet 顶上那条截断的议题），落点该在完整的那一份上。
const SKIP = "script, style, textarea, input, button, [aria-hidden='true'], [data-search-skip]";

function textNodes(container: HTMLElement) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: { node: Text; start: number }[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = (node as Text).data;
    if (!data) continue;
    nodes.push({ node: node as Text, start: text.length });
    text += data;
  }
  return { nodes, text };
}

function locate(nodes: { node: Text; start: number }[], offset: number, end: boolean): [Text, number] {
  let low = 0;
  let high = nodes.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    // 区间终点落在两个节点的接缝上时归前一个节点：Range 不会多罩住下一个节点的开头。
    if (end ? nodes[middle]!.start < offset : nodes[middle]!.start <= offset) low = middle;
    else high = middle - 1;
  }
  const entry = nodes[low]!;
  return [entry.node, offset - entry.start];
}

function closedFolds(element: Element): HTMLDetailsElement[] | null {
  const visible = typeof element.checkVisibility === "function"
    ? element.checkVisibility()
    : element.getClientRects().length > 0;
  if (visible) return [];
  const folds: HTMLDetailsElement[] = [];
  // 一路找到顶，不停在查找区域的边上：duet 的议题区域自己就装在一个折起来的 `<details>` 里。
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node instanceof HTMLDetailsElement && !node.open) folds.push(node);
  }
  // 既看不见、也不在折叠块里（藏起来的副本、display:none 的块）：落过去也什么都看不到。
  return folds.length ? folds : null;
}

/**
 * 不分大小写比较用的字符串，**跟原文逐位对齐**（偏移要拿回去定位 Range），会话和查询必须用
 * 同一把折法。少数字符小写后长度会变（İ → i̇），只有它们自己按原样留着，别的字照常折叠 ——
 * 不能因为会话里有一个这样的字，整条会话都退回大小写敏感。
 */
function foldCase(text: string): string {
  // 整串 toLowerCase 是**看上下文**的：同一个 Σ 在词尾折成 ς、在词中折成 σ，会话和查询里同一个
  // 词所处的上下文不同就折不到一起。ς 一律再折成 σ（等长），两边就只剩字本身说了算。
  const lowered = text.toLowerCase();
  if (lowered.length === text.length) return lowered.replaceAll("ς", "σ");
  let folded = "";
  for (const character of text) {
    const lower = character.toLowerCase();
    folded += lower.length === character.length ? lower : character;
  }
  return folded.replaceAll("ς", "σ");
}

/** 一块区域里所有词的所有出现处，按文档顺序。 */
export function findOccurrences(container: HTMLElement, terms: readonly string[]): SearchOccurrence[] {
  const { nodes, text } = textNodes(container);
  if (!nodes.length) return [];
  const haystack = foldCase(text);
  const needles = terms.map(foldCase);
  const found: Occurrence[] = [];
  let position = 0;
  while (position < haystack.length) {
    let index = -1;
    let needle = "";
    // 同一处有长有短时取长的（terms 已按长度倒序，相同起点先到的就是长的）。
    for (const candidate of needles) {
      const at = haystack.indexOf(candidate, position);
      if (at >= 0 && (index < 0 || at < index)) {
        index = at;
        needle = candidate;
      }
    }
    if (index < 0) break;
    const end = index + needle.length;
    const range = document.createRange();
    range.setStart(...locate(nodes, index, false));
    range.setEnd(...locate(nodes, end, true));
    const element = range.startContainer.parentElement;
    const closed = element ? closedFolds(element) : null;
    if (closed) found.push({ range, term: needle, start: index, end, closed });
    position = end;
  }
  return attachContext(found, haystack);
}

// 上下文只比「字」：空白和 markdown 记号在源文里有、渲染后没有，留着就永远对不齐。
const normalize = (value: string) => value.toLowerCase().replace(/[\s*_`#>|~\\[\]()…-]+/g, "");
const CONTEXT = 24;

/** 出现处连同它前后各一小段字（已归一），pickOccurrence 拿它跟服务端的上下文比。 */
export type SearchOccurrence = Occurrence & { before: string; after: string };

function attachContext(found: Occurrence[], text: string): SearchOccurrence[] {
  return found.map((occurrence) => ({
    ...occurrence,
    before: normalize(text.slice(Math.max(0, occurrence.start - CONTEXT * 4), occurrence.start)).slice(-CONTEXT),
    after: normalize(text.slice(occurrence.end, occurrence.end + CONTEXT * 4)).slice(0, CONTEXT),
  }));
}

function sharedSuffix(left: string, right: string) {
  let count = 0;
  while (count < left.length && count < right.length && left[left.length - 1 - count] === right[right.length - 1 - count]) count += 1;
  return count;
}

function sharedPrefix(left: string, right: string) {
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) count += 1;
  return count;
}

/**
 * 落在哪一处。依次比：
 *   1. 跟服务端给的那段上下文对得上多少字 —— 用户在面板里看的就是那一段；
 *   2. 现在就看得见的优先，免得为一个更早的出现处把折好的执行过程翻开；
 *   3. 文档顺序。
 */
export function pickOccurrence(found: readonly SearchOccurrence[], hint: string): SearchOccurrence | null {
  const context = normalize(hint);
  let best: SearchOccurrence | null = null;
  let bestScore = -1;
  for (const occurrence of found) {
    const at = context.indexOf(normalize(occurrence.term));
    const score = (at < 0 ? 0 : sharedSuffix(context.slice(0, at), occurrence.before)
      + sharedPrefix(context.slice(at + normalize(occurrence.term).length), occurrence.after)) * 2
      + (occurrence.closed.length ? 0 : 1);
    if (score > bestScore) {
      best = occurrence;
      bestScore = score;
    }
  }
  return best;
}

const SCROLLS = /^(auto|scroll|overlay)$/;

/**
 * 从里到外每一层**真能滚**的容器（overflow 是 auto/scroll）。overflow:hidden 的布局壳不在其中：
 * 替它滚就是把整块布局挪走（duet 的议题区域撑高时，曾把任务顶上那排操作一起推出了画面）。
 */
function scrollers(node: Node): HTMLElement[] {
  const list: HTMLElement[] = [];
  for (let element = node.parentElement; element; element = element.parentElement) {
    const style = getComputedStyle(element);
    const vertical = SCROLLS.test(style.overflowY) && element.scrollHeight > element.clientHeight;
    const horizontal = SCROLLS.test(style.overflowX) && element.scrollWidth > element.clientWidth;
    if (vertical || horizontal) list.push(element);
  }
  return list;
}

/** 一个滚动容器此刻露出来的那块（去掉边框和滚动条）。 */
function viewport(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const top = rect.top + element.clientTop;
  const left = rect.left + element.clientLeft;
  return { top, left, bottom: top + element.clientHeight, right: left + element.clientWidth };
}

/** 落点有没有真的露在屏幕上：每一层滚动容器、连同窗口本身，都得框得住它。 */
function onScreen(range: Range, layers: readonly HTMLElement[]): boolean {
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return false;
  const boxes = [...layers.map(viewport), { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth }];
  return boxes.every((box) => rect.bottom > box.top && rect.top < box.bottom && rect.right > box.left && rect.left < box.right);
}

/**
 * 把命中那几个字**本身**送进视线，返回它最后到底露没露出来。
 *
 * 量的是 Range，不是它所在的元素：一段 h2、一大段正文可以跨好几屏，「元素露出来了」不等于
 * 「词露出来了」。从里到外一层层挪 —— 会话流、工具参数那种限高的小滚动框、横向滚的代码块、
 * duet 顶上限高的议题区域都是同一回事：哪一层框不住它，就把那一层滚到它落在上部三分之一
 * （横向落在左侧三分之一），已经框得住的那一层不动。挪完再问一遍框没框住，调用方据此决定
 * 算不算落地 —— 露不出来就不闪、不算数。
 */
export function revealOccurrence(occurrence: Occurrence): boolean {
  const { range } = occurrence;
  const layers = scrollers(range.startContainer);
  for (const layer of layers) {
    const rect = range.getBoundingClientRect();
    const box = viewport(layer);
    if (rect.top < box.top || rect.bottom > box.bottom) {
      layer.scrollTop += rect.top - (box.top + (box.bottom - box.top) / 3);
    }
    if (rect.left < box.left || rect.right > box.right) {
      layer.scrollLeft += rect.left - (box.left + (box.right - box.left) / 3);
    }
  }
  return onScreen(range, layers);
}

const ALL = "search-reveal";
const CURRENT = "search-reveal-current";
/** 亮、灭、亮、灭、亮 —— 最后一下多停一会儿再收。 */
const BLINKS = [0, 220, 440, 660, 880];
const HOLD_MS = 1_600;
const MAX_MARKED = 300;
let timers: number[] = [];
let fallback: HTMLElement | null = null;

function clearFlash() {
  timers.forEach((timer) => window.clearTimeout(timer));
  timers = [];
  if (typeof CSS !== "undefined" && "highlights" in CSS) {
    CSS.highlights.delete(ALL);
    CSS.highlights.delete(CURRENT);
  }
  fallback?.classList.remove("is-jump-target");
  fallback = null;
}

/**
 * 闪：会话里看得见的每一处都闪，落点那一处颜色更重。
 *
 * 走 CSS Custom Highlight API —— 只给文字区间上色，不往 React 管着的 DOM 里插 `<mark>`，
 * 下一次渲染不会跟它打架。不认这套 API 的浏览器退回闪落点所在的那一块。
 */
export function flashOccurrences(found: readonly Occurrence[], current: Occurrence) {
  clearFlash();
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") {
    const block = current.range.startContainer.parentElement?.closest<HTMLElement>("p, li, pre, td, blockquote, h1, h2, h3, h4, h5, h6, div");
    if (!block) return;
    fallback = block;
    block.classList.add("is-jump-target");
    block.addEventListener("animationend", () => { if (fallback === block) clearFlash(); }, { once: true });
    return;
  }
  const others = found.filter((occurrence) => occurrence !== current && !occurrence.closed.length).slice(0, MAX_MARKED);
  const show = () => {
    CSS.highlights.set(ALL, new Highlight(...others.map((occurrence) => occurrence.range)));
    CSS.highlights.set(CURRENT, new Highlight(current.range));
  };
  const hide = () => {
    CSS.highlights.delete(ALL);
    CSS.highlights.delete(CURRENT);
  };
  if (motionReduced()) {
    show();
    timers.push(window.setTimeout(clearFlash, HOLD_MS + BLINKS.at(-1)!));
    return;
  }
  BLINKS.forEach((at, index) => timers.push(window.setTimeout(index % 2 ? hide : show, at)));
  timers.push(window.setTimeout(clearFlash, BLINKS.at(-1)! + HOLD_MS));
}
