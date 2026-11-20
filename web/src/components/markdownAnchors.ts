// 文内锚点：`[实现方案](#实现方案)` 这种目录链接、GFM 脚注、`other.md#section` 跨文件锚点。
//
// 三件事放在一起，因为它们必须用同一套口径：
//   · 标题的 id 怎么生成（GitHub 口径，见 slugger）；
//   · id 的作用域：会话里一屏几十条消息，各自都可能有「## 结论」和 `[^1]`。DOM 的 id 是
//     整页的，所以每份文档给自己的 id 套一个前缀（`scope`，来自 `useId`），文档根上记着这个
//     前缀，查找时只在这一份里找 —— 两条消息谁也够不着谁；
//   · 点下去怎么跳：不改 `location.hash`、不交给浏览器。原生 hash 跳转在这里不可靠（滚动
//     容器是查看器 / 会话栏自己，不是 window；路由的 replaceState 也不留 hash），而交给浏览器
//     的那条兜底是 `target="_blank"` —— 浏览器里新开一页、mac 壳里原地整页重载，文档直接没了。
//
// 锚点的三种形态要分清：没有 `#`（不是锚点）、空片段 `#`（「回到顶部」= 这份文档开头）、
// 命名片段 `#实现方案`。空片段也是文内导航，只是目标是文档本身 —— 拿「有没有目标名」当判据，
// 它就漏回浏览器那条兜底去了。下面用 `""` 表示文档开头。

import { GITHUB_SLUG_REMOVE } from "./githubSlugRegex.ts";

/** 文档根上记前缀的属性（hast 里写 `dataAnchorScope`）。 */
const SCOPE_ATTRIBUTE = "data-anchor-scope";
/** remark-rehype 给脚注这类**生成的** id 加的前缀。从 GitHub 页面上抄来的链接也常带着它。 */
const CLOBBER = "user-content-";

/**
 * GitHub 的标题 slug，跟 github-slugger 逐字一致：小写，去掉上游那张表里的字符（标点、符号、
 * emoji、`²½` 这类，见 githubSlugRegex），空格换成 `-`；同一份文档里重名的依次加 `-1`、`-2`。
 *
 * `reserved`：这份文档里已经被占掉的 id（GFM 脚注那几个），标题按「重名」让开 —— 不然
 * `## user-content-fn-1` 跟脚注条目拿到同一个 id，点脚注跳到标题上。
 */
export function createSlugger(reserved: Iterable<string> = []) {
  const occurrences = new Map<string, number>();
  for (const id of reserved) occurrences.set(id, 0);
  return (text: string): string => {
    const base = text.toLowerCase().replace(GITHUB_SLUG_REMOVE, "").replace(/ /g, "-");
    let slug = base;
    while (occurrences.has(slug)) {
      const count = occurrences.get(base)! + 1;
      occurrences.set(base, count);
      slug = `${base}-${count}`;
    }
    occurrences.set(slug, 0);
    return slug;
  };
}

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const HEADING = /^h[1-6]$/;

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

/**
 * 给这份文档的标题生成 id，并把所有 id（含 GFM 脚注那几个）套上本文档的前缀。
 *
 * 必须排在其它 rehype 插件**之后**：markdownLayout 按脚注的原始 id（`user-content-fn-x`）
 * 判哪几条该画，先改了它就认不出来了。引用这些 id 的 `aria-describedby` 跟着改，脚注角标的
 * 读屏说明才指得到同一份文档里的「Footnotes」那一节。
 */
export function rehypeAnchors(scope: string) {
  return () => (tree: HastNode): void => {
    const generated: string[] = [];
    const collect = (node: HastNode) => {
      if (typeof node.properties?.id === "string") generated.push(node.properties.id);
      for (const child of node.children ?? []) collect(child);
    };
    collect(tree);
    const slug = createSlugger(generated);
    const visit = (node: HastNode) => {
      if (node.type === "element") {
        const properties = node.properties ?? {};
        if (typeof properties.id === "string") properties.id = scope + properties.id;
        else if (HEADING.test(node.tagName ?? "")) properties.id = scope + slug(textOf(node));
        for (const key of ["ariaDescribedBy", "ariaLabelledBy"]) {
          const value = properties[key];
          if (Array.isArray(value)) properties[key] = value.map((id) => scope + String(id));
        }
        node.properties = properties;
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
  };
}

/** 文档根上要挂的属性：查找时凭它认出「这一份」和它的前缀。 */
export const anchorScopeProps = (scope: string) => ({ [SCOPE_ATTRIBUTE]: scope });

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** `#…` 开头的链接指着文内哪个位置（解码后，`""` = 文档开头）；不是文内锚点返回 null。 */
export function inDocumentAnchor(href: string | undefined): string | null {
  const raw = href?.trim();
  if (!raw?.startsWith("#")) return null;
  return decode(raw.slice(1));
}

/** 行号后缀（`#L12`、`#L12-L20`）：打开的是整份文件，不算锚点（见 fileLinkTarget 的 LINE_SUFFIX）。 */
const LINE_FRAGMENT = /^L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/;

/**
 * 指着别的文件的链接（`other.md#section`）带的那一节（`other.md#` 是 `""` = 文件开头）；
 * 没有片段、或只是行号时返回 null。
 */
export function fileLinkAnchor(href: string | undefined): string | null {
  const raw = href?.trim() ?? "";
  const at = raw.indexOf("#");
  if (at <= 0) return null;
  const fragment = raw.slice(at + 1);
  if (LINE_FRAGMENT.test(fragment)) return null;
  return decode(fragment);
}

/** 在 `root` 这一份文档（或它里面的第一份）里找锚点指着的那个元素；`""` 是文档本身。 */
export function findAnchor(root: Element, anchor: string): HTMLElement | null {
  const doc = root.matches(`[${SCOPE_ATTRIBUTE}]`) ? root : root.querySelector(`[${SCOPE_ATTRIBUTE}]`);
  const scope = doc?.getAttribute(SCOPE_ATTRIBUTE);
  if (!(doc instanceof HTMLElement) || scope == null) return null;
  if (anchor === "") return doc;
  // 写法有出入的几种都认，而且能叠着出现：大小写（`#Section`）、从 GitHub 页面抄来的
  // `#user-content-…`（`#user-content-Hello` 要先去前缀、再小写才对得上）。原样的排最前。
  const lower = anchor.toLowerCase();
  const candidates = new Set([anchor, lower]);
  if (lower.startsWith(CLOBBER)) {
    candidates.add(anchor.slice(CLOBBER.length));
    candidates.add(lower.slice(CLOBBER.length));
  }
  for (const candidate of candidates) {
    const found = doc.ownerDocument.getElementById(scope + candidate);
    if (found && doc.contains(found)) return found;
  }
  return null;
}

/**
 * 滚到锚点那里，阅读焦点也跟过去。找到了返回 true。
 *
 * 焦点那一步是原生 hash 跳转本来就做的（顺序焦点起点移到目标）：拦下默认行为之后不补，键盘
 * 用户按 Enter 跳到脚注，再按 Tab 又回到角标附近。标题、脚注条目本身不可聚焦，给一个
 * `tabindex=-1`（只能被程序聚焦，不进 Tab 顺序）。
 */
export function scrollToAnchor(root: Element, anchor: string): boolean {
  const target = findAnchor(root, anchor);
  if (!target) return false;
  target.scrollIntoView({ block: "start" });
  if (target.tabIndex < 0 && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
  return true;
}

/** 文内锚点链接被点下：在它所在的那一份文档里跳过去。 */
export function followInDocumentAnchor(link: Element, anchor: string): boolean {
  const doc = link.closest(`[${SCOPE_ATTRIBUTE}]`);
  return doc ? scrollToAnchor(doc, anchor) : false;
}
