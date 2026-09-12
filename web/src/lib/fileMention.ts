// `@` 引用文件的**纯逻辑**：token 怎么认、选中之后正文怎么改。
//
// 单独一个文件是为了能直接被回归测试引（web/scripts/test-file-mention.mjs），
// 跟 slashMatch.ts 同样的道理：带 React 和 api 的 hook 拿不进 node 测试里跑。

/**
 * 正文末尾正在敲的那个 `@token`，没在敲就返回 null。
 *
 * `@` 必须跟在行首或空白后面 —— 邮箱、`user@host` 这类不该触发。token 里不许再有 `@`
 * 和空白，但**必须允许 `/` `.` `-`**，否则敲到 `@src/` 第一个斜杠就熄火了。
 */
export function fileMentionToken(value: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value);
  return match ? match[1]! : null;
}

/**
 * 把正文末尾的 `@token` 换成选中的路径，并补一个空格。
 *
 * 路径带空格就加引号：不加的话后面那个词会被 agent 当成路径的一部分，或者反过来，
 * 路径在第一个空格处被截断 —— 两种都是「引用了却读不到」，而用户看不出哪儿错了。
 */
export function applyFileMention(value: string, path: string): string {
  const quoted = /\s/.test(path) ? `"${path}"` : path;
  return `${value.replace(/@[^\s@]*$/, "")}@${quoted} `;
}
