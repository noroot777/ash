// 从会话里取一段话，取的是**用户读到的那些话**，不是 DOM 上恰好被扫过的字符。
//
// 会话流里正文和界面装置是混排的：折起来的「执行过程 · 6 工具」、气泡头上的头像、
// 身份与时间、尾栏的账目胶囊、审查泳道与辩论卡的卡头、问答历史的摘要行。跨消息拖选
// 必然扫过它们，而 `Selection.toString()` 照单全收 —— 于是「添加到备忘 / 添加到对话 /
// 在侧聊中提问」三个入口拿到的都是掺着这些碎片的文本（用户反馈：存进备忘的那段里夹
// 着六条「执行过程」）。
//
// **判据先读 HTML 语义，再读声明**（见 CHROME）。这件事不能靠「每个卡片的作者记得加
// 一个标记」：漏标的样子跟「本来就没装置」一模一样，没有任何地方会报错，于是新写一张
// 卡就重新长出一次同样的 bug（审查第 1 轮不拦项列了四处现成的）。而会话里每张卡片的
// 头尾本来就是 `header` / `footer` / `summary` / `time` / `aria-hidden` 写的 —— 认这层
// 语义，它们一处都不用改就对了，新写的卡片也一样。声明那一层只收语义表达不了的例外。
//
// **排版文本只许问浏览器要。** 取文必须保住原页面的排版语义：代码块的缩进、用户气泡
// 的 `white-space: pre-wrap`、段落之间的空行，都由 CSS 和祖先选择器决定。所以这里既
// 不用 `Range.toString()`（它把文本节点首尾相接，一个换行都没有），也不把内容克隆到
// 离屏容器上读 `innerText`（脱离祖先链，`.task-user-bubble > p` 这类规则不再命中，
// 三行用户消息会被折成一行 —— 审查第 1 轮必修 2）。唯一权威是让 `Selection` 在**原
// 文档上**框住那一截，再读它的 `toString()`。

/**
 * 不算正文的东西。
 *
 * - `header` / `footer`：卡片与气泡的元信息行（身份、时间、用时、账目胶囊、操作位）
 * - `summary`：折叠条的标签 —— 它是那个开关本身，内容在 `details` 里
 * - `button` / `[role=button]`：控件 —— 按钮上的字是操作名。代价是**待答**提问卡的候选
 *   项（它们是 `aria-pressed` 的单选按钮）也不进选文；答过之后的历史卡里那些选项是
 *   `li`，照旧取得到。
 * - `time`：时间戳
 * - `[aria-hidden=true]`：纯装饰（图标、头像首字母），它本来就不该被读出来
 * - `[data-selection-chrome]`：语义说不出来的那几处产品判断。目前只有「执行过程」折叠
 *   块：它整块都不是用户要的那段话，连被折进去的那半截正文也不是。
 *
 * markdown 正文不受影响：它渲染出来的是 `p` / `pre` / `li` / `a` / `table`，一个都不在
 * 这张表里；`details`/`summary` 在正文里是纯文本（没有开 rehype-raw）。
 */
const CHROME = 'header,footer,summary,button,[role="button"],time,[aria-hidden="true"],[data-selection-chrome]';

/**
 * 这个选区里还有没有正文可取 —— 浮条的显隐判据。
 *
 * 只问有无，所以用 `Range.toString()` 就够：纯文本拼接和排版文本在「是不是全是空白」
 * 这件事上答案一致，而它没有副作用，可以在每次选区变动时跑。
 */
export function hasSelectionContent(range: Range, root: Element): boolean {
  const parts = contentRanges(range, root);
  return parts ? parts.length > 0 : !!range.toString().trim();
}

/**
 * 选区文本，剔掉中间夹着的界面装置。
 *
 * **会清空当前选区**：排版文本得靠 `Selection` 在原文档上框出每一截来读（理由见文件
 * 头）。所以只许在用户点下浮条、本来就要收起选区的那一刻调用 —— 不要放进选区变化的
 * 回调里，那会打断用户正在拖的选区，还会把自己派发的 `selectionchange` 喂回来。
 */
export function selectionContentText(range: Range, root: Element): string {
  const parts = contentRanges(range, root);
  // null = 没有装置要剔（含「选区整个落在一块装置里」）：原样，一个字节不改。
  if (!parts) return renderedText(range);
  return parts.map((part) => trimSeam(renderedText(part))).filter(Boolean).join("\n\n");
}

/**
 * 把选区按装置切成几截正文；`null` = 不用切。
 *
 * 切口两边的空白留给 `trimSeam` 处理，这里一个字都不动；只把整截都是空白的丢掉 ——
 * 两颗相邻按钮之间那点缝隙不是内容。
 */
function contentRanges(range: Range, root: Element): Range[] | null {
  const chrome = chromeToSkip(range, root);
  if (!chrome.length) return null;
  const parts: Range[] = [];
  // 「还没取的那一截」。每跳过一块装置就把它的起点往后挪一次。
  let rest: Range | null = range.cloneRange();
  for (const element of chrome) {
    if (!rest) break;
    const head = rest.cloneRange();
    head.setEndBefore(element);
    // 空 = 这块装置压在选区头上（选区从它中间起步），它前面没有正文。
    if (!head.collapsed) parts.push(head);
    rest.setStartAfter(element);
    // 起点被推到了选区终点之后 = 这块装置压在选区尾上，后面也没有正文了。
    if (rest.collapsed) rest = null;
  }
  if (rest) parts.push(rest);
  return parts.filter((part) => part.toString().trim());
}

/**
 * 这个选区里要整块跳过的装置，按文档顺序。
 *
 * 只走选区**真正盖住的**那部分 DOM（不相交的子树整棵剪掉），所以开销跟选了多少东西
 * 成正比，跟会话有多长无关 —— 这个判据每次选区变动都要跑一遍。
 */
function chromeToSkip(range: Range, root: Element): Element[] {
  const anchor = elementOf(range.commonAncestorContainer);
  if (!anchor || !root.contains(anchor)) return [];
  // 选区**整个**落在一块装置里 = 用户就是冲它去的（点开执行过程、单独取其中一条工具
  // 输出）。那不是顺带扫过，原样给他，别回一份空文本。
  const enclosing = anchor.closest(CHROME);
  if (enclosing && root.contains(enclosing)) return [];
  const skip: Element[] = [];
  const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => {
      // 不相交就把整棵子树剪掉 —— 这是「只走选区盖住的那部分」的来源。
      if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
      return (node as Element).matches(CHROME) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  while (walker.nextNode()) {
    const element = walker.currentNode as Element;
    // 装置套装置时只认最外层：里层已经随外层整块跳过了，再按它切会把游标往回拖。
    if (skip.some((outer) => outer.contains(element))) continue;
    skip.push(element);
  }
  return skip;
}

const elementOf = (node: Node): Element | null => (node instanceof Element ? node : node.parentElement);

/**
 * 剥掉切口两边的空行。
 *
 * 只删**换行**（连同同一行里那点水平空白），不碰换行之后的空格与制表符 —— 那是正文
 * 自己的缩进。整段 `trim()` 会把代码块首行的四个空格一起削掉，于是原本同级的两行在
 * 备忘里变成不同层级（审查第 1 轮必修 1）。
 */
function trimSeam(text: string): string {
  return text.replace(/^(?:[ \t]*[\r\n])+/, "").replace(/(?:[\r\n][ \t]*)+$/, "");
}

/** 这一截 range 在屏幕上是什么字。借用 `Selection` 来读，所以它会改动当前选区。 */
function renderedText(range: Range): string {
  const selection = window.getSelection();
  if (!selection) return range.toString();
  selection.removeAllRanges();
  selection.addRange(range);
  return selection.toString();
}
