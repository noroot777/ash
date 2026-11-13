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

// 按钮上的字、输入框、读屏专用的那些不是会话内容。
const SKIP = "script, style, textarea, input, button, [aria-hidden='true']";

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

function closedFolds(element: Element, container: HTMLElement): HTMLDetailsElement[] | null {
  const visible = typeof element.checkVisibility === "function"
    ? element.checkVisibility()
    : element.getClientRects().length > 0;
  if (visible) return [];
  const folds: HTMLDetailsElement[] = [];
  for (let node: Element | null = element; node && node !== container; node = node.parentElement) {
    if (node instanceof HTMLDetailsElement && !node.open) folds.push(node);
  }
  // 既看不见、也不在折叠块里（藏起来的副本、display:none 的块）：落过去也什么都看不到。
  return folds.length ? folds : null;
}

/** 容器里所有词的所有出现处，按文档顺序。 */
export function findOccurrences(container: HTMLElement, terms: readonly string[]): SearchOccurrence[] {
  const { nodes, text } = textNodes(container);
  if (!nodes.length) return [];
  // 少数字符小写后长度会变（如 İ），那样偏移就对不上原文了 —— 退回按原样比。
  const lowered = text.toLowerCase();
  const haystack = lowered.length === text.length ? lowered : text;
  const needles = terms.map((term) => haystack === lowered ? term.toLowerCase() : term);
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
    const closed = element ? closedFolds(element, container) : null;
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

/** 把落点摆到视口上部三分之一：正中偏上读着顺，又不贴着顶边。 */
export function scrollToOccurrence(container: HTMLElement, occurrence: Occurrence) {
  const rect = occurrence.range.getBoundingClientRect();
  const view = container.getBoundingClientRect();
  const top = rect.top - view.top + container.scrollTop - container.clientHeight / 3;
  container.scrollTo({ top: Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight)), behavior: "auto" });
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
