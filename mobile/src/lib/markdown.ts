// Lightweight Markdown parsing for the native renderer (MarkdownText). Pure data
// transforms with NO react-native imports — so it's unit-testable on its own and
// the renderer stays a thin view layer. Covers the syntax agents actually emit;
// anything unknown degrades to a plain paragraph and never throws.

export type Span = { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string };

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "code"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string };

// Split one line into styled spans. `code` wins first (its inner text is literal);
// then **bold**, *italic*/_italic_, ![alt](img), [text](url). Unmatched runs stay plain text.
//
// 图片(`![alt](dest)`)**排在链接之前**,而且只留 alt 文字:这个渲染器压根不画图,而 agent
// 写的目的地是**它自己机器上的路径**(`output/shot.png`)。按链接解会得到一个点下去只能
// 静默失败的死链接,外加一个孤零零的「!」。手机上看不见图是功能没做(web 那套配对、快照
// 接口这里都没有),但「看不见」不该表现成「看着像能点」。
export function parseInline(line: string): Span[] {
  const spans: Span[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(!\[[^\]]*\]\([^)]*\))|(\[[^\]]+\]\([^)]+\))/;
  let rest = line;
  while (rest) {
    const m = re.exec(rest);
    if (!m) {
      spans.push({ text: rest });
      break;
    }
    if (m.index > 0) spans.push({ text: rest.slice(0, m.index) });
    const tok = m[0];
    if (tok.startsWith("`")) spans.push({ text: tok.slice(1, -1), code: true });
    else if (tok.startsWith("**")) spans.push({ text: tok.slice(2, -2), bold: true });
    else if (tok.startsWith("![")) {
      // 图片:只留 alt,绝不给它一个点不开的链接。空 alt 也要占一个空 span ——
      // 下面那句「一个 span 都没有就原样返回整行」会把整段 Markdown 原文端出来。
      spans.push({ text: /^!\[([^\]]*)\]/.exec(tok)?.[1] ?? "" });
    } else if (tok.startsWith("[")) {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!;
      spans.push({ text: mm[1], href: mm[2] });
    } else spans.push({ text: tok.slice(1, -1), italic: true });
    rest = rest.slice(m.index + tok.length);
  }
  return spans.length ? spans : [{ text: line }];
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\s+$/, "").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ kind: "para", text: para.join("\n") });
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flushPara();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++; // skip closing fence
      blocks.push({ kind: "code", text: buf.join("\n") });
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      blocks.push({ kind: "heading", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      blocks.push({ kind: "quote", text: q[1] });
      i++;
      continue;
    }
    if (/^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      flushPara();
      const ordered = /^\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const u = /^[-*+]\s+(.*)$/.exec(lines[i]);
        const o = /^\d+\.\s+(.*)$/.exec(lines[i]);
        const hit = ordered ? o : u;
        if (!hit) break;
        items.push(hit[1]);
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return blocks;
}
