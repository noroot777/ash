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
 * 去掉 @ 占位符（@_user_1 之类）。只收拾带占位符的那几行（@ 留下的空隙收成一个空格、行首尾去掉）；
 * 别的行原样，代码、表格的缩进和对齐靠的就是那些空格。
 */
export function stripMentions(text: string, mentions: FeishuMention[]): string {
  const keys = mentions.map((mention) => mention.key).filter(Boolean).sort((a, b) => b.length - a.length);
  const lines = text.split("\n").map((line) => {
    let out = line;
    for (const key of keys) out = out.split(key).join("");
    out = out.replace(/@_user_\d+/g, "");
    return out === line ? line : out.replace(/[ \t]{2,}/g, " ").trim();
  });
  return lines.join("\n").replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}

export function parseMessage(messageType: string, content: string, mentions: FeishuMention[]): ParsedMessage {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(content) as Record<string, unknown>; } catch { /* 当空消息 */ }
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
