// 「这段 Markdown 在页面上读出来是什么字、哪些行算正文」——契约判据的**底层问法**。
// 判到哪一档在 `reviewReportContract.ts`，第一栏说了什么在 `reviewReportVerdict.ts`。
//
// 拆出来是因为 `reviewReportContract.ts` 写到了 680 行（上限 700），而这一份自成一件事：
// 它一个判据都不下，只回答「用户到底读得到什么」。上面两份都靠它——问题三行有没有字、
// 第一栏是不是只写了一句判定，问的都是同一件事。
import type { Parsed, ParsedNode } from "./reviewReportContract.ts";

/** 页面上**出字**的行内节点：容器本身不出字，出字的是它们里面的这两种。 */
const READS = new Set(["text", "inlineCode"]);
/** 只是**包着字**的行内节点：字在它们里面，递归进去接着读。 */
const WRAPS = new Set(["emphasis", "strong", "delete", "link", "linkReference"]);
/** 既不出字也不占地方的：软硬换行。 */
const BLANKS = new Set(["break"]);

/**
 * 这段行号范围里，每一行**渲染出来是什么字**；以及这段里有没有**读不出字的东西**。
 *
 * 第 7 轮的反例：`你会遇到：[](#symptom)`。源码里冒号后面确实有字符，页面上却只有一个
 * 空标签——三行占着位置，一个字都读不到。所以「冒号后有没有字」得问渲染结果，不能问源码。
 *
 * 第 8 轮接着问：图片的 `alt` 算不算页面上的字？**不算**。`MarkdownBody` 对页面提供不了
 * 的本地磁盘图片直接 `return null`，那一行整个不见；就算图片正常显示，出来的也是一张图，
 * `alt` 只在点开灯箱后当标题出现（`ImagePreview`），正文里一个字都不出。所以三行说明各写
 * 成一张图，页面上就是一片空白——`alt` 不能单独证明一行说明存在。
 *
 * 出字的只有 `READS`，`WRAPS` 递归进去接着读；**剩下的一律记成 `unreadable`**。图片、内联
 * HTML、脚注这些不是「没有内容」，是「有东西但读不出字」——问「这一行有没有字」时它们不
 * 算数，问「这一栏是不是只写了一句话」时它们就是那句话之外的东西。两个问题的安全答案方向
 * 相反，所以一次遍历把两件事都记下来，由问的人各取所需。
 *
 * 容器按白名单递归而不是「有 children 就进去」：漏认一种写法只是读不到字、跟着降档，认错
 * 一种就是把读不到的字当成读得到的。
 */
type Visible = { lines: Map<number, string>; unreadable: boolean };

function visibleLines(root: Parsed, from: number, to: number): Visible {
  const lines = new Map<number, string>();
  let unreadable = false;
  const add = (at: number, text: string) => {
    if (at < from || at >= to || text === "") return;
    lines.set(at, (lines.get(at) ?? "") + text);
  };
  const walk = (node: ParsedNode) => {
    if (!node.position) return;
    const start = node.position.start.line - 1;
    if (READS.has(node.type) && "value" in node && typeof node.value === "string") {
      node.value.split("\n").forEach((piece, index) => add(start + index, piece));
      return;
    }
    if (WRAPS.has(node.type) && "children" in node && Array.isArray(node.children)) {
      for (const child of node.children) walk(child);
      return;
    }
    if (!BLANKS.has(node.type) && start >= from && start < to) unreadable = true;
  };
  /** 一个块（段落 / 标题 / 列表项里的段落）里的行内节点，逐个读。 */
  const enter = (block: ParsedNode) => {
    if (!("children" in block) || !Array.isArray(block.children)) return;
    for (const child of block.children) walk(child);
  };
  // 标题也收：第一栏可以写成 `### 能不能验收`，那一栏的字就在标题里。`proseLines` 另外
  // 管着「哪些行算正文」，问题三行不会因此被标题冒充。
  for (const node of root.children) {
    if (node.type === "paragraph" || node.type === "heading") enter(node);
    else if (node.type === "list") {
      for (const item of node.children) for (const child of item.children) if (child.type === "paragraph") enter(child);
    }
  }
  return { lines, unreadable };
}

/** `from`..`to` 这段**页面上读出来的整段字**，按行序拼回去。 */
function readableText(root: Parsed, from: number, to: number): Visible & { text: string } {
  const seen = visibleLines(root, from, to);
  const text = [...seen.lines.keys()]
    .sort((a, b) => a - b)
    .map((at) => seen.lines.get(at) ?? "")
    .join("\n");
  return { ...seen, text };
}

/**
 * 这段行号范围里，哪些行是**正文**——顶层段落，以及顶层列表直属项里的段落。
 *
 * 白名单跟 `markCandidateStarts` 同一套，理由也一样：围栏、HTML 块、块引用、嵌套列表里
 * 的字看着顶格，解析树里各有归属。第 6 轮的反例就是围栏——一段「写法示例」代码块里照着
 * 模板写了那三行，按源码逐行扫就成了一条真问题，真正的问题被折进明细。黑名单永远缺一
 * 条，白名单漏掉一种写法只是不拆。
 *
 * 这里收**节点覆盖的每一行**而不是起始行：那三行是一段里的三个软换行，本来就该整段收。
 */
function proseLines(root: Parsed, from: number, to: number): Set<number> {
  const lines = new Set<number>();
  const take = (node: ParsedNode) => {
    if (!node.position) return;
    for (let at = node.position.start.line - 1; at <= node.position.end.line - 1; at += 1) {
      if (at >= from && at < to) lines.add(at);
    }
  };
  for (const node of root.children) {
    if (node.type === "paragraph") take(node);
    else if (node.type === "list") {
      for (const item of node.children) {
        for (const child of item.children) if (child.type === "paragraph") take(child);
      }
    }
  }
  return lines;
}

export { visibleLines, readableText, proseLines };
export type { Visible };
