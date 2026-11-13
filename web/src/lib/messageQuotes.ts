/**
 * 把一条用户消息按 Markdown 引用块切开：连续的 `>` 行合成一段引文，其余照原样是正文。
 *
 * 用户消息本身按纯文本画（不走 Markdown，打什么就显示什么），唯独引用要认出来——「添加到
 * 对话」写进对话框的就是 `> ` 前缀的引文，不认的话气泡里就是一排裸的 `>`。只认引用这一种，
 * 别的 Markdown 记号一律不碰。代码围栏里的 `>` 是代码（shell 提示符、diff），不算引用。
 */
export type MessageBlock = { kind: "quote" | "text"; text: string };

const QUOTE_LINE = /^ {0,3}> ?/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function splitMessageQuotes(text: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let lines: string[] = [];
  let kind: MessageBlock["kind"] = "text";
  let fence: string | null = null;
  const flush = () => {
    const body = trimBlankLines(lines);
    if (body) blocks.push({ kind, text: body });
    lines = [];
  };
  for (const line of text.split("\n")) {
    const marker = line.match(FENCE)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    } else if (marker) {
      fence = marker;
    }
    const quoted = !fence && !marker && QUOTE_LINE.test(line);
    const next = quoted ? "quote" : "text";
    if (next !== kind) {
      flush();
      kind = next;
    }
    lines.push(quoted ? line.replace(QUOTE_LINE, "") : line);
  }
  flush();
  return blocks;
}

/** 去掉首尾的空行（引文和正文之间那行空行是分隔，不是内容），行内缩进原样留着。 */
function trimBlankLines(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]!.trim()) start += 1;
  while (end > start && !lines[end - 1]!.trim()) end -= 1;
  return lines.slice(start, end).join("\n");
}
