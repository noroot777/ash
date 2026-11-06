// 推到飞书之前的文本处理：脱敏、去掉会被飞书当成富文本解析的片段、截断。
//
// 卡片里来自智能体和用户的文字一律走 plain_text（见 feishu/cards.ts），不会被当成 markdown
// 渲染 —— 所以这里不用转义 markdown，只处理三件事：
//   · 密钥：智能体的提问、失败原因里偶尔会带着 token（它在命令行里看见了就贴出来）。
//   · `<at …>`：飞书在 plain_text 里也认 @ 标签，任务正文里一句 `<at id=all></at>` 就能 @ 全群。
//   · 长度：单张卡片上限 30 KB，超了整张发不出去。
import { redactSecrets } from "../executors/spawn.js";

const AT_TAG = /<\s*\/?\s*at\b[^>]*>/gi;
// 飞书自己的几类凭据前缀；通用的 sk-/Bearer/token= 交给 redactSecrets。
const FEISHU_SECRETS = /\b(t-|u-|cli_)[A-Za-z0-9]{20,}/g;

export function scrubText(text: string | null | undefined, max = 1500): string {
  if (!text) return "";
  let out = redactSecrets(text).replace(FEISHU_SECRETS, "$1***").replace(AT_TAG, "");
  out = out.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out.length > max ? `${out.slice(0, max)}…（已截断，完整内容在 ash 里）` : out;
}

/** 卡片标题：一行、去 @、短。 */
export function scrubTitle(text: string | null | undefined, max = 60): string {
  const line = scrubText(text, 400).replace(/\s+/g, " ");
  return (line.length > max ? `${line.slice(0, max)}…` : line) || "（无标题任务）";
}
