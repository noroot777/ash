import type { Note } from "@navi/shared";

// `@` 引用随手记的**纯逻辑**：哪些随手记算命中、列表上那一行写什么、选中之后正文变成什么。
// 跟 fileMention.ts 同样的理由单独成文件：回归测试（web/scripts/test-note-mention.mjs）
// 要能直接引，带 React 和 api 的 hook 拿不进 node 里跑。
//
// 和文件引用的根本区别：文件是**把路径留在正文里**让 agent 自己去读，随手记是**把内容
// 本身带进来** —— 正文替换掉 `@token`，附件并进输入框的附件栏。agent 不认识「随手记」
// 这个东西，留一个 `@随手记标题` 在正文里它什么也读不到。

/** 一屏列几条。随手记是挑「那一条」，不是翻档案；再多就该接着打字缩小范围。 */
export const NOTE_MENTION_LIMIT = 5;

/** 随手记的标题：第一行非空的字。跟随手记面板列表上看到的是同一个名字。 */
export function noteTitle(body: string): string {
  return body.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 42) || "无标题随手记";
}

/**
 * 正在敲的 token 命中哪几条。空 token 给最近的几条（列表本来就按更新时间倒序）；
 * token 里有 `/` 时一条不给 —— 那是在敲路径，混进几条随手记只会让回车选错东西。
 */
export function matchNotes(notes: readonly Note[], token: string, limit = NOTE_MENTION_LIMIT): Note[] {
  if (token.includes("/")) return [];
  const needle = token.toLowerCase();
  const hits = needle ? notes.filter((note) => note.body.toLowerCase().includes(needle)) : notes;
  return hits.slice(0, limit);
}

/**
 * 命中在标题之外时，列表上补一句命中的那一行：不写的话用户只看见一个毫不相干的标题，
 * 不知道这条为什么在这里。命中就在标题里（或没在敲字）时返回 null。
 */
export function noteExcerpt(body: string, token: string): string | null {
  const needle = token.toLowerCase();
  if (!needle || noteTitle(body).toLowerCase().includes(needle)) return null;
  const line = body.split(/\r?\n/).map((item) => item.trim()).find((item) => item.toLowerCase().includes(needle));
  if (!line) return null;
  const at = line.toLowerCase().indexOf(needle);
  // 从命中处往前留一小截上下文，长行不至于把命中挤到省略号后面去。
  const start = Math.max(0, at - 8);
  return `${start > 0 ? "…" : ""}${line.slice(start)}`;
}

/**
 * 把正文末尾的 `@token` 换成随手记的正文。多行的随手记后面接一个换行，单行的接一个空格 ——
 * 都是「接着往下写」最顺手的那个位置。前面的字一个都不动。
 */
export function applyNoteMention(value: string, body: string): string {
  const text = body.trim();
  const rest = value.replace(/@[^\s@]*$/, "");
  return `${rest}${text}${text.includes("\n") ? "\n" : " "}`;
}
