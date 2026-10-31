// 从会话里取一段话，取的是**用户读到的那些话**，不是 DOM 上恰好被扫过的字符。
//
// 会话流里正文和界面装置是混排的：折起来的「执行过程 · 6 工具」、气泡头上的头像、
// 身份与时间、尾栏的账目胶囊。跨消息拖选必然扫过它们，而 `Selection.toString()` 照
// 单全收 —— 于是「添加到备忘 / 添加到对话 / 在侧聊中提问」三个入口拿到的都是掺着这
// 些碎片的文本（用户反馈：存进备忘的那段里夹着六条「执行过程」）。
//
// 判据只有一条：**标了 `data-selection-chrome` 的子树不是正文**。由装置自己在渲染处
// 声明身份（`grep -r 'data-selection-chrome' web/src` 就是全部标记点），这里不靠
// `.task-message-content > header` 这类后代选择器猜结构——结构一变它就悄悄失效，而
// 失效的样子跟「本来就没装置」一模一样。

const CHROME = "[data-selection-chrome]";

/**
 * 选区文本，剔掉中间夹着的界面装置。
 *
 * 没有装置相交时原样返回 `selection.toString()`：绝大多数选区走的是这条路，它一个
 * 字节都不该变。
 */
export function selectionContentText(selection: Selection, root: Element): string {
  const range = selection.getRangeAt(0);
  const chrome = chromeToSkip(range, root);
  if (!chrome.length) return selection.toString();
  const parts: string[] = [];
  // 「还没取的那一截」。每跳过一块装置就把它的起点往后挪一次。
  let rest: Range | null = range.cloneRange();
  for (const element of chrome) {
    if (!rest) break;
    const head = rest.cloneRange();
    head.setEndBefore(element);
    // 空 = 这块装置压在选区头上（选区从它中间起步），它前面没有正文。
    if (!head.collapsed) parts.push(renderedText(head));
    rest.setStartAfter(element);
    // 起点被推到了选区终点之后 = 这块装置压在选区尾上，后面也没有正文了。
    if (rest.collapsed) rest = null;
  }
  if (rest) parts.push(renderedText(rest));
  return parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
}

/** 这个选区里要整块跳过的装置，按文档顺序。 */
function chromeToSkip(range: Range, root: Element): Element[] {
  const skip: Element[] = [];
  for (const element of root.querySelectorAll(CHROME)) {
    if (!range.intersectsNode(element)) continue;
    // 选区**整个**落在这块装置里 = 用户就是冲它去的（点开执行过程、单独取其中一条
    // 工具输出）。那不是顺带扫过，原样给他，别回一份空文本。
    if (element.contains(range.commonAncestorContainer)) return [];
    // 装置套装置时只认最外层：里层已经随外层整块跳过了，再按它切会把游标往回拖。
    if (skip.some((outer) => outer.contains(element))) continue;
    skip.push(element);
  }
  return skip;
}

/**
 * 这一截 range 在**屏幕上**是什么字。
 *
 * 不能用 `Range.toString()`：它只是把文本节点首尾相接，段落之间一个换行都没有，整条
 * 回复会被挤成一行（`Selection.toString()` 有换行，是因为它走的是排版）。又不能把
 * selection 临时挪到子 range 上去读——那会打断用户正在拖的选区，还会把自己派发的
 * `selectionchange` 喂回这条计算路径。所以把这一截克隆到一个离屏容器里读 `innerText`：
 * 块级元素该换的行由布局自己说了算。
 */
function renderedText(range: Range): string {
  const host = document.createElement("div");
  // 必须真的参与布局 —— `display:none` 的子树 `innerText` 读出来是空的。
  host.style.cssText = "position:fixed;top:0;left:-99999px;width:1024px;pointer-events:none;";
  host.setAttribute("aria-hidden", "true");
  host.appendChild(range.cloneContents());
  document.body.appendChild(host);
  try {
    return host.innerText;
  } finally {
    host.remove();
  }
}
