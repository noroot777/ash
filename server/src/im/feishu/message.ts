// 飞书消息的内容：抠出文字、@ 了谁、带了哪些图片和文件。
//
// 飞书的消息正文是一段 JSON 字符串，按 message_type 各有形状：
//   text   {"text":"@_user_1 你好"}       —— @ 写成占位符，真身在 mentions 里
//   post   {"title":"…","content":[[{tag:"text",text:"…"},{tag:"img",image_key:"…"},…],…]}
//          （有时外面还包一层语言：{"zh_cn":{title,content}}）
//   image  {"image_key":"img_…"}
//   file   {"file_key":"file_…","file_name":"a.pdf"}
// 其余类型（音视频、表情包、卡片、合并转发……）不处理，回一句「只认文字、图片和文件」。
export interface FeishuMention {
  key: string;
  openId: string | null;
}

export interface ParsedMessage {
  text: string;
  attachments: { kind: "image" | "file"; key: string; name: string | null }[];
  supported: boolean;
  /** 正文是认得的类型、但内容解析不了：不能当空消息（附件、文字都可能丢了），要让他重发。 */
  unreadable?: boolean;
}

type PostNode = { tag?: string; text?: string; image_key?: string; file_key?: string; file_name?: string; user_id?: string };

function postBody(raw: Record<string, unknown>): { title?: string; content?: PostNode[][] } {
  if (Array.isArray(raw.content)) return raw as { title?: string; content?: PostNode[][] };
  for (const value of Object.values(raw)) {
    if (value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content)) {
      return value as { title?: string; content?: PostNode[][] };
    }
  }
  return {};
}

/**
 * 去掉 @ 占位符（@_user_1 之类）：只去掉占位符本身，外加最多一个把它和正文隔开的空白，别的空白一律原样 ——
 * 代码、表格的缩进和对齐靠的就是那些空格，跟 @ 写在同一行的也一样。连着的几个 @ 当一段处理；在行中间的一段，
 * 两侧都有空白就去掉一侧，只有一侧有就留着它（不把两个词粘在一起）；在行首的一段连同它前面的空白、后面恰好一个
 * 空白一起去掉（再多的空白是用户自己打的缩进）；在行尾的一段连同两侧空白去掉。开头那几行只剩空白的去掉。
 */
export function stripMentions(text: string, mentions: FeishuMention[]): string {
  const escape = (key: string) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keys = mentions.map((mention) => mention.key).filter(Boolean).sort((a, b) => b.length - a.length).map(escape);
  const token = `(?:${[...keys, "@_user_\\d+"].join("|")})`;
  const group = `${token}(?:[ \\t]+${token})*`;
  const leading = new RegExp(`^[ \\t]*${group}[ \\t]?`);
  const trailing = new RegExp(`[ \\t]*${group}[ \\t]*$`);
  const inner = new RegExp(`([ \\t]?)${group}([ \\t]?)`, "g");
  const lines = text.split("\n").map((line) => line.replace(leading, "").replace(trailing, "")
    .replace(inner, (_match, before: string, after: string) => before || after));
  return lines.join("\n").replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}

export function parseMessage(messageType: string, content: string, mentions: FeishuMention[]): ParsedMessage {
  if (!["text", "post", "image", "file"].includes(messageType)) return { text: "", attachments: [], supported: false };
  let parsed: unknown = null;
  try { parsed = JSON.parse(content); } catch { /* 下一行按解析不了处理 */ }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { text: "", attachments: [], supported: true, unreadable: true };
  const raw = parsed as Record<string, unknown>;
  switch (messageType) {
    case "text":
      return { text: stripMentions(String(raw.text ?? ""), mentions), attachments: [], supported: true };
    case "post": {
      const post = postBody(raw);
      const lines: string[] = post.title ? [post.title] : [];
      const attachments: ParsedMessage["attachments"] = [];
      for (const paragraph of post.content ?? []) {
        let line = "";
        for (const node of paragraph ?? []) {
          if (node.tag === "text" || node.tag === "a") line += node.text ?? "";
          // @ 节点补回一个占位符，让它两侧的分隔空白跟 text 消息走同一条去 @ 规则（是谁无所谓，正文里本来就不留）。
          else if (node.tag === "at") line += "@_user_0";
          else if (node.tag === "img" && node.image_key) attachments.push({ kind: "image", key: node.image_key, name: null });
          else if (node.tag === "media" && node.file_key) attachments.push({ kind: "file", key: node.file_key, name: node.file_name ?? null });
          else if (node.tag === "code_block") line += node.text ?? "";
        }
        lines.push(line);
      }
      return { text: stripMentions(lines.join("\n"), mentions), attachments, supported: true };
    }
    case "image":
      return { text: "", attachments: typeof raw.image_key === "string" ? [{ kind: "image", key: raw.image_key, name: null }] : [], supported: true };
    case "file":
      return {
        text: "",
        attachments: typeof raw.file_key === "string" ? [{ kind: "file", key: raw.file_key, name: typeof raw.file_name === "string" ? raw.file_name : null }] : [],
        supported: true,
      };
    default:
      return { text: "", attachments: [], supported: false };
  }
}
