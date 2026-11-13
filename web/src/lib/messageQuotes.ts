/**
 * 把一条用户消息按 Markdown 引用块切开：连续的 `>` 行合成一段引文，其余照原样是正文。
 *
 * 用户消息本身按纯文本画（不走 Markdown，打什么就显示什么），唯独引用要认出来——「添加到
 * 对话」写进对话框的就是 `> ` 前缀的引文，不认的话气泡里就是一排裸的 `>`。只认引用这一种，
 * 别的 Markdown 记号一律不碰。代码围栏里的 `>` 是代码（shell 提示符、diff），不算引用。
 */
export type MessageBlock = { kind: "quote" | "text"; text: string };

const QUOTE_LINE = /^ {0,3}> ?/;
/** 开围栏后面可以跟语言名之类的信息串。 */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
/** 关围栏后面只许有空白：围栏里一行 ```not-a-fence 还是代码，不能把围栏提前关掉。 */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

export function splitMessageQuotes(text: string): MessageBlock[] {
  const blocks: { kind: MessageBlock["kind"]; lines: string[] }[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    let quoted = false;
    if (fence) {
      const close = line.match(FENCE_CLOSE)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
    } else {
      fence = line.match(FENCE_OPEN)?.[1] ?? null;
      quoted = !fence && QUOTE_LINE.test(line);
    }
    const kind = quoted ? "quote" : "text";
    if (blocks.at(-1)?.kind !== kind) blocks.push({ kind, lines: [] });
    blocks.at(-1)!.lines.push(quoted ? line.replace(QUOTE_LINE, "") : line);
  }
  // 没有引用就是原文一字不动（首尾空行是用户自己打的）。
  if (!blocks.some((block) => block.kind === "quote")) return [{ kind: "text", text }];
  // 有引用时，只去掉贴着引文那一侧的空行——那是引文和正文之间的分隔，不是内容。引文自己
  // 首尾的空 `>` 行同理。
  return blocks.flatMap((block, index) => {
    const quote = block.kind === "quote";
    const body = trimBlankLines(block.lines, quote || index > 0, quote || index < blocks.length - 1);
    return body.trim() ? [{ kind: block.kind, text: body }] : [];
  });
}

function trimBlankLines(lines: string[], head: boolean, tail: boolean): string {
  let start = 0;
  let end = lines.length;
  if (head) while (start < end && !lines[start]!.trim()) start += 1;
  if (tail) while (end > start && !lines[end - 1]!.trim()) end -= 1;
  return lines.slice(start, end).join("\n");
}
