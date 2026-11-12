import type { FreshMark } from "../lib/useSmoothText.ts";

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};

/** 淡入多久；和 styles/task-conversation.css 里 .is-fresh-text 的动画同长。 */
export const FRESH_MS = 280;

/** 这几种元素里的字整块出现：代码要原样交给高亮，插入点是执行步骤的占位。 */
const ATOMIC = new Set(["pre", "code", "div"]);

/**
 * 把正文里按 `marks` 分好的每一段新字包进各自的 `<span>`（run-4）。
 *
 * 每段都包、包了就不拆：react-markdown 按「同名兄弟里的第几个」起 key，拆掉前面那段，后面
 * 每一段的 key 都会挪一格，正在淡入的字会被换进一颗已经淡完的 span 里，一下子跳到全亮。
 * 只有刚放出来不到 FRESH_MS 的那几段带淡入的 class；更早的是不带动画的空壳，就算因为
 * 重新解析被重挂，也不会再闪一次。
 */
export function rehypeFreshText(marks: FreshMark[], now: number) {
  return () => (tree: HastNode): void => {
    if (!marks.length) return;
    const first = marks[0]!.from;
    const visit = (node: HastNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === "element") {
          if (!ATOMIC.has(child.tagName ?? "")) visit(child);
          return [child];
        }
        if (child.type !== "text" || !child.value) return [child];
        const start = child.position?.start?.offset;
        const end = child.position?.end?.offset;
        // 源码和显示的字一一对应时才切（转义、实体会让两边长度对不上）。
        if (typeof start !== "number" || typeof end !== "number" || end <= first) return [child];
        if (end - start !== child.value.length) return [child];
        return split(child.value, start, marks, now);
      });
    };
    visit(tree);
  };
}

function split(value: string, start: number, marks: FreshMark[], now: number): HastNode[] {
  const pieces: HastNode[] = [];
  const end = start + value.length;
  const head = Math.max(0, marks[0]!.from - start);
  if (head > 0) pieces.push({ type: "text", value: value.slice(0, head) });
  marks.forEach((mark, index) => {
    const from = Math.max(mark.from, start);
    const to = Math.min(marks[index + 1]?.from ?? Number.POSITIVE_INFINITY, end);
    if (to <= from) return;
    pieces.push({
      type: "element",
      tagName: "span",
      properties: now - mark.at < FRESH_MS ? { className: ["is-fresh-text"] } : {},
      children: [{ type: "text", value: value.slice(from - start, to - start) }],
    });
  });
  return pieces;
}
