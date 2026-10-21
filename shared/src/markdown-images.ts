// 一份 Markdown 里 `![](…)` 到底指到哪儿 —— 服务端与展示端**共用的唯一口径**。
//
// 为什么非得是同一份:服务端按它决定「把哪些本机图片复制进 uploads、标成正文哪一句引用
// 的」,展示端按它决定「正文里哪一处该换成站内地址、哪一张附件已经被正文领走」。两边各
// 写一份正则,立刻出现两种错:服务端存了而展示端配不上(图没了),或者展示端认领了而服务
// 端没存(附件卡片被吃掉、正文又什么都画不出来)。后者就是审查第 1 轮 F2 抓到的一幕。
//
// 这**不是** CommonMark 解析器,它覆盖的是 agent 真会写的那几种形状:
//   ✓ `![alt](path)` / `![alt](<path with space>)` / `![alt](path "title")` / 括号内换行
//   ✓ 跳过围栏代码块(``` / ~~~)与行内代码(`…`)—— 例子里的路径不是图
//   ✗ 引用式(`![a][ref]` + `[ref]: path`)、缩进四格的代码块、裸 `<img>` 标签
// 不认的那几种**两边一致地不认**,所以它们顶多「不显示」,绝不会显示成另一张图。

export type MarkdownImageRef = {
  /** 目的地原文:剥掉了 `<>` 与首尾空白,但没有做任何转义解码。 */
  destination: string;
  /** `destination` 在原文里的起止(含 `<>`)。改写正文时按它原地替换最稳。 */
  start: number;
  end: number;
};

/**
 * 带协议的目标(`http:`、`data:`、`blob:`、`file:`)不是「相对某个目录」的写法。
 *
 * **至少两个字符**是硬要求:`D:\work\shot.png` 的 `D:` 否则会被当成协议,Windows 上
 * 所有盘符绝对路径就都被当成站外地址扔掉(审查第 1 轮 F4,正是上一版引入的回归)。
 * 现实里没有单字母协议,而盘符恒为单字母,这条判据两边都够用。
 */
const URL_SCHEME = /^[a-z][a-z0-9+.-]+:/i;

export function hasUrlScheme(value: string): boolean {
  return URL_SCHEME.test(value.trim());
}

type Range = { start: number; end: number };

function inRanges(ranges: Range[], index: number): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

/** 围栏代码块(含两道围栏);没闭合的围栏一直算到结尾 —— 正在流式输出时就是这样。 */
function fencedRanges(text: string): Range[] {
  const ranges: Range[] = [];
  const fence = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*$/gm;
  let open: RegExpExecArray | null;
  while ((open = fence.exec(text))) {
    const marker = open[1]!;
    const bodyStart = open.index + open[0].length;
    const closer = new RegExp(`^[ \\t]{0,3}\\${marker[0]}{${marker.length},}[ \\t]*$`, "m");
    const found = closer.exec(text.slice(bodyStart));
    const end = found ? bodyStart + found.index + found[0].length : text.length;
    ranges.push({ start: open.index, end });
    fence.lastIndex = end;
  }
  return ranges;
}

/** 行内代码:同长度反引号成对(CommonMark 的口径);没配上的反引号不算代码。 */
function inlineCodeRanges(text: string, fenced: Range[]): Range[] {
  const ranges: Range[] = [];
  const ticks = /`+/g;
  let run: RegExpExecArray | null;
  while ((run = ticks.exec(text))) {
    if (inRanges(fenced, run.index)) continue;
    const closer = new RegExp("`{" + run[0].length + "}(?!`)", "g");
    closer.lastIndex = run.index + run[0].length;
    const close = closer.exec(text);
    if (!close || inRanges(fenced, close.index)) continue;
    ranges.push({ start: run.index, end: close.index + close[0].length });
    ticks.lastIndex = close.index + close[0].length;
  }
  return ranges;
}

// 目的地单独一组(连 `<>` 一起),起止靠 `d` 标志拿 —— 用 indexOf 去找会被 alt 文字里
// 一模一样的那段抢走(`![x.png](x.png)`)。
const IMAGE = /!\[[^\]]*\]\(\s*(<[^<>\n]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/dg;

export function markdownImageRefs(text: string): MarkdownImageRef[] {
  if (!text.includes("![")) return [];
  const fenced = fencedRanges(text);
  const code = [...fenced, ...inlineCodeRanges(text, fenced)];
  const refs: MarkdownImageRef[] = [];
  for (const match of text.matchAll(IMAGE)) {
    if (match.index === undefined || inRanges(code, match.index)) continue;
    const span = match.indices?.[1];
    const raw = match[1];
    if (!span || !raw) continue;
    const destination = (raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw).trim();
    if (destination) refs.push({ destination, start: span[0], end: span[1] });
  }
  return refs;
}
