// 本地目录迁移的配置格式层：一份配置里有几处要换、能不能安全改、改完是什么，全按**解码之后的值**判，
// 不按原文字节判 —— `"/Users/…"` 和 `"/Users/…"` 是同一条路径，原文里找不到旧根不等于没有。
// 清点、真做、核对走的都是这里的 analyzeConfig，同一份判据。
//
// - JSON：解析成值，键和字符串值逐个换（rewriteJson），整份重新序列化。
// - JSONC、TOML：要保住注释和排版，所以按词法切成字符串 / 注释 / 其余，只改字符串和注释的内容：
//   字符串先解码、换、再编码（原文没有转义的原样替换，有转义的按 JSON 规则重新编码，两种格式都认）。
//   改完再整份解析一遍，和「旧值按同一规则换」逐项比，不一致就不改 —— 这一步是语义核对，不复用切词的结论。
//   TOML 的解析靠 Python 3.11+ 的 tomllib；本机没有它时，有要换的 TOML 一律报成没法核对，不改。
//   多行字符串里带转义的（行尾反斜杠会吃掉换行，重新编码保不住原样）报成不支持，不改。
import { spawnSync } from "node:child_process";
import { countJsonRefs, countRefs, rewriteJson, rewriteText } from "./relocate-checkout-paths.mjs";

/** 键排好序的序列化：比较两份解析结果是否同一个值。 */
const canonical = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

// PATH 上排第一的 python3 不一定带 tomllib（macOS 自带的 /usr/bin/python3 是 3.9）：依次找，用第一个带的。
const PYTHON_CANDIDATES = ["python3", "python3.14", "python3.13", "python3.12", "python3.11", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"];
let tomlPython;
/** 带 tomllib 的 Python；一个都没有返回 null。 */
export function tomlPythonPath() {
  if (tomlPython === undefined) tomlPython = PYTHON_CANDIDATES.find((p) => spawnSync(p, ["-c", "import tomllib"], { stdio: "ignore" }).status === 0) ?? null;
  return tomlPython;
}

/** TOML → 值（经 JSON 转一道，日期时间转成字符串）；不合法返回 { ok: false }，本机没有 tomllib 返回 null。 */
export function parseToml(text) {
  const python = tomlPythonPath();
  if (!python) return null;
  const r = spawnSync(python, ["-c", "import sys, json, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read()), default=str))"], { input: text, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? { ok: true, value: JSON.parse(r.stdout) } : { ok: false };
}

/** TOML 词法：[{ type, text, open?, close? }]，type 为 raw / comment / basic / literal / mlbasic / mlliteral。 */
function tomlTokens(text) {
  const out = [];
  let raw = "";
  const flush = () => { if (raw) out.push({ type: "raw", text: raw }); raw = ""; };
  for (let i = 0; i < text.length;) {
    const c = text[i];
    const ml = text.startsWith('"""', i) ? '"""' : text.startsWith("'''", i) ? "'''" : null;
    if (c === "#") {
      flush();
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      out.push({ type: "comment", text: text.slice(i, stop) });
      i = stop;
    } else if (ml) {
      flush();
      let j = i + 3;
      for (; j < text.length; j += 1) {
        if (ml === '"""' && text[j] === "\\") { j += 1; continue; }
        if (text.startsWith(ml, j)) break;
      }
      if (j >= text.length) throw new Error("多行字符串没有收尾");
      let close = j + 3;
      while (close < text.length && text[close] === ml[0] && close - j < 5) close += 1; // 收尾前可以再带两个引号
      out.push({ type: ml === '"""' ? "mlbasic" : "mlliteral", open: ml, close: ml, text: text.slice(i + 3, close - 3) });
      i = close;
    } else if (c === '"' || c === "'") {
      flush();
      let j = i + 1;
      for (; j < text.length && text[j] !== c && text[j] !== "\n"; j += 1) if (c === '"' && text[j] === "\\") j += 1;
      if (text[j] !== c) throw new Error("字符串没有收尾");
      out.push({ type: c === '"' ? "basic" : "literal", open: c, close: c, text: text.slice(i + 1, j) });
      i = j + 1;
    } else {
      raw += c;
      i += 1;
    }
  }
  flush();
  return out;
}

const TOML_ESCAPES = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\x1b", '"': '"', "\\": "\\" };
function decodeTomlBasic(s) {
  return s.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|x[0-9A-Fa-f]{2}|.)/g, (_, e) => {
    if (/^[uUx]/.test(e) && e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16));
    if (Object.hasOwn(TOML_ESCAPES, e)) return TOML_ESCAPES[e];
    throw new Error(`认不得的转义 \\${e}`);
  });
}

/** JSONC 词法：字符串、`//` 与 `/* *\/` 注释、其余。 */
function jsoncTokens(text) {
  const out = [];
  let raw = "";
  const flush = () => { if (raw) out.push({ type: "raw", text: raw }); raw = ""; };
  for (let i = 0; i < text.length;) {
    if (text.startsWith("//", i) || text.startsWith("/*", i)) {
      flush();
      const block = text[i + 1] === "*";
      const end = block ? text.indexOf("*/", i + 2) : text.indexOf("\n", i);
      if (block && end < 0) throw new Error("块注释没有收尾");
      const stop = end < 0 ? text.length : block ? end + 2 : end;
      out.push({ type: "comment", text: text.slice(i, stop) });
      i = stop;
    } else if (text[i] === '"') {
      flush();
      let j = i + 1;
      for (; j < text.length && text[j] !== '"' && text[j] !== "\n"; j += 1) if (text[j] === "\\") j += 1;
      if (text[j] !== '"') throw new Error("字符串没有收尾");
      out.push({ type: "basic", open: '"', close: '"', text: text.slice(i + 1, j) });
      i = j + 1;
    } else {
      raw += text[i];
      i += 1;
    }
  }
  flush();
  return out;
}

/** JSONC → 值：去掉注释和尾逗号再按 JSON 解析。 */
function parseJsonc(tokens) {
  let s = "";
  for (const t of tokens) s += t.type === "comment" ? " " : t.type === "basic" ? `"${t.text}"` : t.text;
  // 尾逗号只可能出现在字符串之外；字符串已经整段带引号拼回来了，按 JSON 字符串跳过即可。
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '"') { let j = i + 1; for (; s[j] !== '"'; j += 1) if (s[j] === "\\") j += 1; out += s.slice(i, j + 1); i = j; continue; }
    if (s[i] === "," && /^\s*[}\]]/.test(s.slice(i + 1))) continue;
    out += s[i];
  }
  return JSON.parse(out);
}

/** 一个词改写之后的样子和换了几处；改不了（多行字符串带转义）抛错。 */
function rewriteToken(t, rules, kind) {
  if (t.type === "raw" || t.type === "comment") {
    const r = rewriteText(t.text, rules);
    return { text: t.text, next: r.text, count: r.count };
  }
  const wrap = (body) => `${t.open}${body}${t.close}`;
  if (t.type === "literal" || t.type === "mlliteral") {
    const r = rewriteText(t.text, rules); // 没有转义：原文就是值（多行的开头换行不影响前缀替换）
    return { text: wrap(t.text), next: wrap(r.text), count: r.count };
  }
  const decoded = kind === "toml"
    ? decodeTomlBasic(t.type === "mlbasic" ? t.text.replace(/^\r?\n/, "").replace(/\\[ \t]*\r?\n[\s]*/g, "") : t.text)
    : JSON.parse(`"${t.text}"`);
  const r = rewriteText(decoded, rules);
  if (!r.count) return { text: wrap(t.text), next: wrap(t.text), count: 0 };
  if (!t.text.includes("\\")) return { text: wrap(t.text), next: wrap(rewriteText(t.text, rules).text), count: r.count };
  if (t.type === "mlbasic") throw new Error("多行字符串里带转义，改写保不住原样");
  return { text: wrap(t.text), next: JSON.stringify(r.text), count: r.count };
}

/** 一份配置里解码之后的全部字符串（键和值；解析不了的返回 []）：用来找配置里登记过的别的目录。 */
export function configStrings(text, kind) {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); walk(x); }
  };
  try {
    if (kind === "json") walk(JSON.parse(text));
    else if (kind === "jsonc") walk(parseJsonc(jsoncTokens(text)));
    else if (kind === "toml") {
      for (const t of tomlTokens(text)) {
        if (t.type === "basic") out.push(decodeTomlBasic(t.text));
        else if (t.type === "literal") out.push(t.text);
      }
    }
  } catch { /* 解析不了：没有可认的登记 */ }
  return out;
}

/**
 * 一份配置（或数据文件）：{ count, problems, next }。count 是解码后要换的处数，problems 非空就不许改，
 * next 是改完的全文（count 为 0 或有问题时是 null）。kind：json / jsonc / toml / text。
 */
export function analyzeConfig(text, kind, rules) {
  if (kind === "text") {
    const r = rewriteText(text, rules);
    return { count: r.count, problems: [], next: r.count ? r.text : null };
  }
  if (kind === "json") {
    let value;
    try { value = JSON.parse(text); } catch { const n = countRefs(text, rules); return { count: n, problems: n ? ["不是合法 JSON"] : [], next: null }; }
    const count = countJsonRefs(value, rules);
    if (!count) return { count, problems: [], next: null };
    const collisions = [];
    const rewritten = rewriteJson(value, rules, collisions);
    const problems = collisions.map((c) => `${c.at} 下的键 ${c.key} 改完会和已有的 ${c.existing} 重名（两份都有内容，该留哪份、怎么合只有你知道）`);
    const next = JSON.stringify(rewritten, null, /^\{\n(\s+)/.exec(text)?.[1] ?? 2) + (text.endsWith("\n") ? "\n" : "");
    return { count, problems, next: problems.length ? null : next };
  }
  let tokens;
  try { tokens = kind === "toml" ? tomlTokens(text) : jsoncTokens(text); }
  catch (error) { const n = countRefs(text, rules); return { count: n, problems: n ? [`切不开（${error.message}）`] : [], next: null }; }
  let count = 0;
  let next = "";
  const problems = [];
  for (const t of tokens) {
    try {
      const r = rewriteToken(t, rules, kind);
      count += r.count;
      next += r.next;
    } catch (error) {
      problems.push(error.message);
      count += countRefs(t.text, rules) || 1;
    }
  }
  if (!count) return { count, problems: [], next: null };
  // 语义核对：旧值按同一规则换（键撞名在这里查出来），和改完那份解析出来的值逐项比。
  const parse = (s) => {
    if (kind === "jsonc") { try { return { ok: true, value: parseJsonc(jsoncTokens(s)) }; } catch { return { ok: false }; } }
    return parseToml(s);
  };
  const before = parse(text);
  if (before === null) return { count, problems: [...problems, "本机找不到带 tomllib 的 Python（3.11+），核对不了改完的 TOML，不改"], next: null };
  if (!before.ok) return { count, problems: [...problems, `原文就不是合法的 ${kind.toUpperCase()}`], next: null };
  const collisions = [];
  const expected = rewriteJson(before.value, rules, collisions);
  for (const c of collisions) problems.push(`${c.at} 下的键 ${c.key} 改完会和已有的 ${c.existing} 重名（两份都有内容，该留哪份、怎么合只有你知道）`);
  if (!problems.length) {
    const after = parse(next);
    if (!after.ok) problems.push(`改完不是合法的 ${kind.toUpperCase()}`);
    else if (canonical(after.value) !== canonical(expected)) problems.push("改完解析出来的值和「旧值逐项换掉」对不上，不改");
  }
  return { count, problems, next: problems.length ? null : next };
}
