// 本地目录迁移（scripts/relocate-checkout.mjs）的路径口径：旧根 → 新根怎么认、怎么换。
//
// 所有改写都是「前缀替换」，难点只在**边界**，而值分两种，边界判法不同：
//
// ① 整个值就是一条路径（库里的路径列、配置的键和路径值；可以带空格）：按路径分段判，旧根后面只能是
//    `/` 或结尾。`/x/harness copy`、`/x/harness中文`、`/x/harness:2` 都是另一个目录 —— 不管那个目录此刻
//    在不在磁盘上。
// ② 正文里的路径（命令、提示词、消息）：路径在哪结束没法证明，只能按惯例判。后面紧跟任何文字的字母数字
//    或 `_ - ~ @ + %` 的是另一个目录名的一部分（`harness2`、`harness中文`）；空白、引号、标点是路径结束。
//    另外把「已知的别的目录」逐个排除：磁盘上真有的兄弟目录（`harness copy`），以及库里、配置里按①登记
//    过的别的完整路径（那个目录暂时不在磁盘上也算）。旧根后面紧跟非 ASCII 文字、又对不上已知目录的
//    （「…/harness对比」），分不清，不换，报成未解决。
//    2026-11-19 拿真库量过：旧根后面接空格的 173 处全是命令（`&& `、`--dir`、`rev-parse`）和中文正文，
//    以旧根开头、后面不是 `/` 的整值一处都没有。
//
// 起点不对称是有意的：前面紧挨着汉字（「截图目录/Users/…」）照样换（真库 39 处全是这种正文，没有以中文
// 目录名结尾、再接 `/Users/…` 的相对路径）；前面紧挨着 ASCII 路径字符的（`/Volumes/x/Users/…`）才是别的
// 路径里的一段。
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

/** 整个值是不是一条路径（可以带空格，不能跨行），是的话返回去掉 `file://` 之后的那段。 */
const wholePath = (text) => (/^(?:file:\/\/)?[~/][^\n\r\t]*$/.test(text) ? text.replace(/^file:\/\//, "") : null);

/**
 * 一个整值路径如果以旧写法开头、后面却不是 `/`，它就是另一个目录：返回它的名字后缀（`" copy"`、`"中文"`），
 * 用来在正文里排除。不是这种值返回 null。「整值路径」= 以 `/` 或 `~` 开头、不跨行、旧写法只出现这一次
 * （出现两次的是一段提到好几条路径的正文）。
 */
export function otherDirSuffix(text, old) {
  const p = typeof text === "string" ? wholePath(text) : null;
  if (!p || !p.startsWith(old) || p.length === old.length || p[old.length] === "/") return null;
  if (p.includes(old, old.length)) return null; // 旧写法出现不止一次：这是一段正文，不是一条路径
  return p.slice(old.length).split("/")[0];
}

/**
 * 一组「旧写法 → 新写法」：绝对路径、`~/` 写法（旧根在家目录下时）、claude 会话目录。
 *
 * - siblings：已知的别的目录的名字后缀（见顶部②），正文里旧根后面接着其中任何一个的不换。
 * - claude：{ prefixes, moves }。claude 会话目录名是有损编码（`/x/harness-old`、`/x/harness/old`、
 *   `/x/harness中文` 可以换出同一个名字），文本里没法从名字判归属，所以只按**有来源的映射**换：
 *   prefixes 是各个 claude 配置目录在文本里可能的写法（{ text, dir }，dir 是搬后的规范位置），
 *   moves 是 `<dir>/projects/<旧名>` → 新名（本次认领的，加上账本里记过的改名）。
 */
export function rewriteRules({ from, to, home, siblings = [], claude = null }) {
  const notSibling = siblings.length ? `(?!${[...new Set(siblings)].map(escapeRe).join("|")})` : "";
  const rules = [{ kind: "path", old: from, new: to }];
  if (home && isUnder(from, home) && from !== home && isUnder(to, home)) {
    rules.push({ kind: "tilde", old: `~/${relative(home, from)}`, new: `~/${relative(home, to)}` });
  }
  for (const rule of rules) {
    rule.notSibling = notSibling;
    rule.re = new RegExp(START + escapeRe(rule.old) + notSibling + BOUNDARY, "gu");
  }
  if (claude?.prefixes.length && claude.moves.size) {
    const byText = new Map(claude.prefixes.map((p) => [p.text, p.dir]));
    const alt = [...byText.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
    rules.push({
      kind: "claude-dir",
      old: `/projects/${claudeSlug(from)}`,
      re: new RegExp(`${START}(${alt})/projects/(-[A-Za-z0-9-]+)(?![A-Za-z0-9-])`, "g"),
      map: (whole, prefix, name) => {
        const next = claude.moves.get(`${byText.get(prefix)}/projects/${name}`);
        return next ? `${prefix}/projects/${next}` : null;
      },
    });
  }
  return rules;
}

/** 一段文本里按规则换；返回 { text, count }。count 为 0 时 text 原样（同一个字符串）。 */
export function rewriteText(text, rules) {
  if (typeof text !== "string" || !text) return { text, count: 0 };
  let count = 0;
  let out = text;
  for (const rule of rules) {
    if (!out.includes(rule.old)) continue;
    if (rule.map) {
      out = out.replace(rule.re, (...m) => {
        const next = rule.map(...m);
        if (!next || next === m[0]) return m[0];
        count += 1;
        return next;
      });
      continue;
    }
    if (otherDirSuffix(out, rule.old) !== null) continue; // 整个值是另一个目录的路径
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
 * 正文里旧根后面紧跟非 ASCII 文字、又对不上已知目录的写法（「…/harness对比」）：可能是正文粘在路径后面，
 * 也可能是另一个目录，分不清，所以不换，数出来报成未解决。整值路径不算（按①它就是另一个目录）。
 */
export function countAmbiguous(text, rules) {
  if (typeof text !== "string") return 0;
  let n = 0;
  for (const rule of rules) {
    if (rule.map || !text.includes(rule.old) || otherDirSuffix(text, rule.old) !== null) continue;
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

/** 文本里所有带引号的字面量，解码之后的内容（`"…"` 按 JSON 转义解，`'…'` 原样）。 */
export function stringLiterals(text) {
  const out = [];
  for (const m of text.matchAll(/"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'/g)) {
    let value = m[2];
    if (value === undefined) {
      try { value = JSON.parse(`"${m[1]}"`); } catch { value = m[1]; }
    }
    out.push(value);
  }
  return out;
}

/**
 * 文本格式的结构化配置（TOML、JSONC）改完会不会撞名：不靠解析器，在字面量层面保守地判。键里的路径
 * 一定是带引号的字面量（路径里有 `/`，做不了裸键），所以「改完的某个字面量等于文件里已有的另一个字面量、
 * 或者两个不同的字面量改完相同」是撞名的必要条件 —— 命中就当撞名（值相同也会被拦下，那是可接受的误报）。
 * 比的是解码之后的内容：TOML 里 `'…'` 与 `"…"` 内容相同就是同一个键。
 */
export function literalCollisions(text, rules) {
  const literals = stringLiterals(text);
  const existing = new Set(literals);
  const seen = new Map();
  const out = [];
  for (const v of new Set(literals)) {
    const next = rewriteText(v, rules).text;
    if (next === v) continue;
    if (existing.has(next)) out.push({ key: v, existing: next });
    else if (seen.has(next)) out.push({ key: v, existing: `${seen.get(next)}（两者改完相同）` });
    seen.set(next, v);
  }
  return out;
}
