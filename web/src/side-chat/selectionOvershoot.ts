/**
 * 选区首尾越过正文、搭到相邻块边界上的那一截剪掉。
 *
 * WebKit 按词 / 按段扩展选区时会把段落末尾的分段符一起吃进去：三击一段，或者双击后第二下
 * 按着时指针往下抖进气泡的内边距里，选区终点都会落到**下一个块的开头**。字一个没多，WebKit
 * 却会把两个块之间的空隙整条涂成选中色（Chrome 不涂）——气泡下面横出一条灰带，浮条也跟着
 * 选区最后一个盒子被推到灰带下面。所以收尾时把终点拉回最后一个看得见的字后面，起点同理。
 *
 * 只剪「什么都没有」的那一截：剪掉的部分里有一个看得见的字、或一张图，就原样不动。
 */
export function trimBlockOvershoot(range: Range): Range | null {
  if (range.collapsed || range.commonAncestorContainer.nodeType === Node.TEXT_NODE) return null;
  const texts = visibleTexts(range);
  if (!texts.length) return null;
  const first = texts[0];
  const last = texts[texts.length - 1];
  const trimmed = range.cloneRange();
  // 边界点就在这个字所在的元素里（比如整段 selectNodeContents）不算越界，不去改写它。
  if (!first.parentElement?.contains(range.startContainer)) trimmed.setStart(first, 0);
  if (!last.parentElement?.contains(range.endContainer)) trimmed.setEnd(last, last.length);
  const head = range.cloneRange();
  head.setEnd(trimmed.startContainer, trimmed.startOffset);
  const tail = range.cloneRange();
  tail.setStart(trimmed.endContainer, trimmed.endOffset);
  if (holdsMedia(head)) trimmed.setStart(range.startContainer, range.startOffset);
  if (holdsMedia(tail)) trimmed.setEnd(range.endContainer, range.endOffset);
  const same = trimmed.compareBoundaryPoints(Range.START_TO_START, range) === 0
    && trimmed.compareBoundaryPoints(Range.END_TO_END, range) === 0;
  return same ? null : trimmed;
}

/** 选区里真选到了看得见的字的那些文本节点，按文档顺序。 */
function visibleTexts(range: Range): Text[] {
  const found: Text[] = [];
  // 元素也过一遍过滤器：没碰到选区的整棵子树当场剪掉，开销跟选区多大成正比，跟会话多长无关。
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
      return node.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  while (walker.nextNode()) {
    const text = walker.currentNode as Text;
    const from = text === range.startContainer ? range.startOffset : 0;
    const to = text === range.endContainer ? range.endOffset : text.length;
    if (/\S/.test(text.data.slice(from, to)) && text.parentElement?.checkVisibility()) found.push(text);
  }
  return found;
}

const holdsMedia = (part: Range) => !part.collapsed && !!part.cloneContents().querySelector("img, video, canvas");
