// 本地目录迁移（scripts/relocate-checkout.mjs）的路径口径：旧根 → 新根怎么认、怎么换。
//
// 所有改写都是「前缀替换」，难点只在**边界**：`/Users/x/code/harness` 后面紧跟的必须是路径的
// 结束（`/`、引号、空白、标点、行尾……），`harness-old`、`harness2`、`harness.bak` 是另一个目录，
// 一个字节都不能碰。`.` 单独算：后面跟着名字字符（`harness.bak`）是别的目录，句末的 `harness。`
// `harness.` 是路径结束。
import { relative, sep } from "node:path";

const NAME_CHAR = "A-Za-z0-9_\\-";
const BOUNDARY = `(?![${NAME_CHAR}]|\\.[${NAME_CHAR}])`;
// 起点同理：前面紧挨着路径字符的（`/Volumes/x/Users/…`、`foo~/code/…`）是别的路径里的一段；
// `file://` 后面、JSON 转义过的换行/制表符（`\\n/Users/…`）后面的是同一条路径。
const START = `(?<=^|[^${NAME_CHAR}.~/]|file://|\\\\[nrt])`;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** claude 存会话的目录名：路径里每个非字母数字字符换成 `-`（与 server/src/handoff-collect.ts 同口径）。 */
export const claudeSlug = (p) => p.replace(/[^A-Za-z0-9]/g, "-");

/** claude 对超长目录名会截断再拼哈希；这类目录名没法按前缀换，交给人工。 */
export const CLAUDE_SLUG_MAX = 200;

/** grok 按 encodeURIComponent(工作目录) 起会话目录名。 */
export const grokDirName = (p) => encodeURIComponent(p);

/** p 是否就是 root，或在 root 底下（按路径分段，不按字符串前缀）。 */
export function isUnder(p, root) {
  if (typeof p !== "string" || !p) return false;
  if (p === root) return true;
  return p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** root 底下的 p 换到 newRoot 底下；不在 root 底下返回 null。 */
export function mapPath(p, root, newRoot) {
  if (!isUnder(p, root)) return null;
  const rest = relative(root, p);
  return rest ? `${newRoot}${sep}${rest}` : newRoot;
}

/**
 * 一组「旧写法 → 新写法」：绝对路径、`~/` 写法（旧根在家目录下时）、claude 会话目录名
 * （只认 `.claude/projects/` 后面那一段，别处出现的 `-Users-…` 不是路径）。
 */
export function rewriteRules({ from, to, home }) {
  const rules = [{ kind: "path", old: from, new: to }];
  if (home && isUnder(from, home) && from !== home && isUnder(to, home)) {
    rules.push({ kind: "tilde", old: `~/${relative(home, from)}`, new: `~/${relative(home, to)}` });
  }
  rules.push({ kind: "claude-slug", old: claudeSlug(from), new: claudeSlug(to), after: `.claude${sep}projects${sep}` });
  return rules.map((rule) => ({
    ...rule,
    re: new RegExp(
      // claude 目录名里 `-` 就是原来的 `/`，所以它后面可以紧跟 `-`；只有字母数字才说明是另一个名字。
      (rule.after ? `(?<=${escapeRe(rule.after)})` : START) + escapeRe(rule.old) + (rule.kind === "claude-slug" ? "(?![A-Za-z0-9])" : BOUNDARY),
      "g",
    ),
  }));
}

/** 一段文本里按规则换；返回 { text, count }。count 为 0 时 text 原样（同一个字符串）。 */
export function rewriteText(text, rules) {
  if (typeof text !== "string" || !text) return { text, count: 0 };
  let count = 0;
  let out = text;
  for (const rule of rules) {
    if (!out.includes(rule.old)) continue;
    out = out.replace(rule.re, () => {
      count += 1;
      return rule.new;
    });
  }
  return { text: count ? out : text, count };
}

/** 文本里还剩几处按规则会被换的写法（核对用）。 */
export const countRefs = (text, rules) => rewriteText(text, rules).count;

/**
 * JSON 值逐层改写：字符串值和**对象的键**都换（~/.claude.json 的 projects 按路径做键）。
 * 键换完撞上已有的键时，保留已有的那个、丢掉旧键那份，并记进 collisions。
 */
export function rewriteJson(value, rules, collisions = [], at = "$") {
  if (typeof value === "string") return rewriteText(value, rules).text;
  if (Array.isArray(value)) return value.map((v, i) => rewriteJson(v, rules, collisions, `${at}[${i}]`));
  if (!value || typeof value !== "object") return value;
  const out = {};
  const renamed = [];
  for (const [key, v] of Object.entries(value)) {
    const nextKey = rewriteText(key, rules).text;
    if (nextKey !== key) {
      renamed.push([key, nextKey, v]);
      continue;
    }
    out[key] = rewriteJson(v, rules, collisions, `${at}.${key}`);
  }
  for (const [key, nextKey, v] of renamed) {
    if (Object.hasOwn(out, nextKey)) {
      collisions.push({ at, key, kept: nextKey });
      continue;
    }
    out[nextKey] = rewriteJson(v, rules, collisions, `${at}.${nextKey}`);
  }
  return out;
}
