// 本地目录迁移（scripts/relocate-checkout.mjs）的路径口径：旧根 → 新根怎么认、怎么换。
//
// 所有改写都是「前缀替换」，难点只在**边界**：`/Users/x/code/harness` 后面紧跟的必须是路径的
// 结束（`/`、引号、空白、标点、行尾……）。后面跟着**任何文字**的字母数字（`harness2`、`harness中文`）
// 或 `_ - ~ @ + %` 的，是另一个目录，一个字节都不能碰。`.` 单独算：后面跟着名字字符（`harness.bak`）
// 是别的目录，句末的 `harness.` 是路径结束。磁盘上真有的、名字以旧根开头再接空格标点的兄弟目录
// （访达复制出来的 `harness copy`、`harness 2`）由调用方列成 siblings，逐个排除。
//
// 起点不对称是有意的：前面紧挨着汉字（「截图目录/Users/…」）照样换。2026-11-19 拿真库量过：
// 旧根前面紧挨汉字的 39 处全是这种正文，而以中文目录名结尾、再接 `/Users/…` 的相对路径不存在。
// 前面紧挨着 ASCII 路径字符的（`/Volumes/x/Users/…`、`foo~/code/…`）才是别的路径里的一段。
import { relative, sep } from "node:path";

const NAME = "\\p{L}\\p{N}\\p{M}_\\-~@+%";
const BOUNDARY = `(?![${NAME}]|\\.[${NAME}])`;
// `file://` 后面、JSON 转义过的换行/制表符（`\\n/Users/…`）后面的是同一条路径。
const START = "(?<=^|[^A-Za-z0-9_\\-.~/@+%]|file://|\\\\[nrt])";

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
 * 一组「旧写法 → 新写法」：绝对路径、`~/` 写法（旧根在家目录下时）、claude 会话目录名。
 *
 * - siblings：旧根的上级目录里、名字是「旧根名 + 后缀」的兄弟目录的那些后缀（`" copy"`、`" (1)"`）。
 *   旧根后面接着其中任何一个的，按那个兄弟目录算。
 * - claudeName：claude 会话目录名 → 新名字（不是这棵树的返回 null）。目录名是有损编码
 *   （`/x/harness-old` 和 `/x/harness/old` 都叫 `-x-harness-old`），文本里没法按前缀判，
 *   所以只换清点时有证据认领的那些（见 relocate-checkout-agents.mjs 的 scanClaude）。
 */
export function rewriteRules({ from, to, home, siblings = [], claudeName = () => null }) {
  const notSibling = siblings.length ? `(?!${siblings.map(escapeRe).join("|")})` : "";
  const rules = [{ kind: "path", old: from, new: to }];
  if (home && isUnder(from, home) && from !== home && isUnder(to, home)) {
    rules.push({ kind: "tilde", old: `~/${relative(home, from)}`, new: `~/${relative(home, to)}` });
  }
  for (const rule of rules) {
    rule.notSibling = notSibling;
    rule.re = new RegExp(START + escapeRe(rule.old) + notSibling + BOUNDARY, "gu");
  }
  rules.push({ kind: "claude-slug", old: claudeSlug(from), re: /(?<=\.claude\/projects\/)-[A-Za-z0-9-]+/g, map: claudeName });
  return rules;
}

/**
 * 整个值就是一条路径（没有空白、以旧写法开头）时，按路径分段判：旧根后面接着目录名里也能出现的
 * ASCII 标点（`harness:2`、`harness(1)`、`harness,v2`）就是另一个目录。库里的路径列、JSON 的键
 * 都是这种；正文里那些标点才是路径结束，归上面那套边界管。
 */
function wholePathElsewhere(text, rule) {
  if (!text.startsWith(rule.old) || /\s/.test(text)) return false;
  return /^[:,;()[\]{}'!#&=$^]/.test(text.slice(rule.old.length));
}

/** 一段文本里按规则换；返回 { text, count }。count 为 0 时 text 原样（同一个字符串）。 */
export function rewriteText(text, rules) {
  if (typeof text !== "string" || !text) return { text, count: 0 };
  let count = 0;
  let out = text;
  for (const rule of rules) {
    if (!out.includes(rule.old)) continue;
    if (rule.map) {
      out = out.replace(rule.re, (name) => {
        const next = rule.map(name);
        if (!next || next === name) return name;
        count += 1;
        return next;
      });
      continue;
    }
    if (wholePathElsewhere(out, rule)) continue;
    out = out.replace(rule.re, () => {
      count += 1;
      return rule.new;
    });
  }
  return { text: count ? out : text, count };
}

/** 文本里还剩几处按规则会被换的写法（核对用）。 */
export const countRefs = (text, rules) => rewriteText(text, rules).count;

/** JSON 值里（键和字符串值）还有几处要换 —— 按解析后的字符串数，原文里的 `\u0000` 这类转义不挡边界。 */
export function countJsonRefs(value, rules) {
  if (typeof value === "string") return countRefs(value, rules);
  if (Array.isArray(value)) return value.reduce((n, v) => n + countJsonRefs(v, rules), 0);
  if (!value || typeof value !== "object") return 0;
  return Object.entries(value).reduce((n, [k, v]) => n + countRefs(k, rules) + countJsonRefs(v, rules), 0);
}

/**
 * 旧根后面紧跟非 ASCII 文字的写法（「…/harness对比」）：可能是正文粘在路径后面，也可能是另一个
 * 目录，分不清，所以不换，只数出来给人看。
 */
export function countAmbiguous(text, rules) {
  if (typeof text !== "string") return 0;
  let n = 0;
  for (const rule of rules) {
    if (rule.map || !text.includes(rule.old)) continue;
    n += text.match(new RegExp(START + escapeRe(rule.old) + rule.notSibling + "(?=[^\\x00-\\x7F])(?=[\\p{L}\\p{N}])", "gu"))?.length ?? 0;
  }
  return n;
}

/**
 * JSON 值逐层改写：字符串值和**对象的键**都换（~/.claude.json 的 projects 按路径做键）。
 * 键换完撞上已有的键时，两份都留在原处不动（旧键不改名），记进 collisions —— 调用方据此拒绝改这份
 * 文件：哪份该留、怎么合并只有人知道，丢掉任何一份都是悄悄丢配置。
 */
export function rewriteJson(value, rules, collisions = [], at = "$") {
  if (typeof value === "string") return rewriteText(value, rules).text;
  if (Array.isArray(value)) return value.map((v, i) => rewriteJson(v, rules, collisions, `${at}[${i}]`));
  if (!value || typeof value !== "object") return value;
  const out = {};
  const keys = Object.keys(value);
  for (const key of keys) {
    let nextKey = rewriteText(key, rules).text;
    if (nextKey !== key && (Object.hasOwn(value, nextKey) || Object.hasOwn(out, nextKey))) {
      collisions.push({ at, key, existing: nextKey });
      nextKey = key;
    }
    out[nextKey] = rewriteJson(value[key], rules, collisions, `${at}.${nextKey}`);
  }
  return out;
}
