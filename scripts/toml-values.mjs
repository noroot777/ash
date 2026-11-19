// 读出 TOML 里**一张表自己那几个键**的值(`[mcp_servers.ash]` 底下的 command / args / enabled),给「这条登记起的是什么」用。
//
// 为什么不能逐行找 `command =` / `args =`:那样子表(`[mcp_servers.ash.env]` 里恰好也叫 command 的环境变量)会被混进来,
// 多行数组(`args = [` 换行再写路径)又只读到第一行 —— 一个方向误删别人的登记,另一个方向漏掉 Navi 的(审查第 3 轮 R5)。
// 所以这里按 TOML 的写法把这张表从表头扫到下一个表头:键(裸键、引号键、点号键)= 值(四种字符串、跨行数组、内联表、
// 其余标量),注释只在字符串外面算。读不通就返回 null —— 调用方据此「认不准、不写」,不拿半份结果去判归属。
import { stripTomlNoise, unquoteToml } from "./toml-scan.mjs";

const HEADER = /^\s*(\[\[?)((?:[^\]"']|"(?:[^"\\]|\\.)*"|'[^']*')*)\]\]?\s*$/;

/** text 里第 from 个字符开始的一个值;返回 [值, 结束位置] 或 null。字符串交出文本,数组交出数组,其余交出原文。 */
function value(text, from) {
  let i = from;
  const ch = text[i];
  if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
    const q = text.slice(i, i + 3);
    let j = i + 3;
    for (;;) {
      const end = text.indexOf(q, j);
      if (end < 0) return null;
      if (q === '"""' && text[end - 1] === "\\" && text[end - 2] !== "\\") { j = end + 1; continue; }
      let close = end + 3;
      while (text[close] === q[0] && close < end + 5) close += 1; // 结尾多出来的一两个引号属于正文
      const raw = text.slice(i + 3, close - 3).replace(/^\r?\n/, "");
      return [q === "'''" ? raw : raw.replace(/\\\r?\n\s*/g, "").replace(/\\(.)/g, (_, c) => ({ n: "\n", t: "\t", r: "\r" }[c] ?? c)), close];
    }
  }
  if (ch === '"' || ch === "'") {
    const m = (ch === '"' ? /^"(?:[^"\\\n]|\\.)*"/ : /^'[^'\n]*'/).exec(text.slice(i));
    const s = m && unquoteToml(m[0]);
    return s === null || s === undefined ? null : [s, i + m[0].length];
  }
  if (ch === "[" || ch === "{") {
    const close = ch === "[" ? "]" : "}";
    const out = [];
    i += 1;
    for (;;) {
      i = skip(text, i, ch === "[");
      if (i >= text.length) return null;
      if (text[i] === close) return [ch === "[" ? out : text.slice(from, i + 1), i + 1];
      if (text[i] === ",") { i += 1; continue; }
      if (ch === "{") {
        const k = key(text, i);
        if (!k) return null;
        i = skip(text, k[1], false);
        if (text[i] !== "=") return null;
        i = skip(text, i + 1, false);
      }
      const v = value(text, i);
      if (!v) return null;
      if (ch === "[") out.push(v[0]);
      i = v[1];
    }
  }
  const m = /^[^\s,\]}#]+/.exec(text.slice(i));
  return m ? [m[0], i + m[0].length] : null;
}

/** 跳过空白(和注释;数组里还能跨行)。 */
function skip(text, i, lines) {
  for (;;) {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || (lines && (text[i] === "\n" || text[i] === "\r")))) i += 1;
    if (text[i] !== "#") return i;
    const nl = text.indexOf("\n", i);
    i = nl < 0 ? text.length : (lines ? nl + 1 : nl);
  }
}

/** 一个键(可以是点号键);返回 [路径, 结束位置] 或 null。 */
function key(text, i) {
  const path = [];
  for (;;) {
    i = skip(text, i, false);
    const m = /^(?:[A-Za-z0-9_-]+|"(?:[^"\\\n]|\\.)*"|'[^'\n]*')/.exec(text.slice(i));
    if (!m) return null;
    const part = /^["']/.test(m[0]) ? unquoteToml(m[0]) : m[0];
    if (part === null || part === undefined) return null;
    path.push(part);
    i = skip(text, i + m[0].length, false);
    if (text[i] !== ".") return [path, i];
    i += 1;
  }
}

/**
 * 表头路径恰好是 `table` 的那张表(只这一张,不含子表)里写的键值:`{ "command": "node", "args": [...], "env.X": "…" }`。
 * 没有这张表返回 {};读不通返回 null。
 */
export function tomlTableValues(text, table) {
  // 表头按剔掉注释和多行字符串之后的行认(行号不变),省得字符串里一行像表头的文本被当成表头。
  const stripped = stripTomlNoise(text);
  if (stripped.why) return null;
  const lines = text.split("\n");
  let start = -1;
  let end = lines.length;
  for (let n = 0; n < stripped.lines.length; n += 1) {
    const head = HEADER.exec(stripped.lines[n]);
    if (!head) continue;
    if (start >= 0) { end = n; break; }
    const path = key(head[2], 0);
    if (head[1] === "[" && path && skip(head[2], path[1], false) === head[2].length && path[0].join("\0") === table.join("\0")) start = n + 1;
  }
  if (start < 0) return {};
  const body = lines.slice(start, end).join("\n");
  const out = {};
  let i = 0;
  for (;;) {
    i = skip(body, i, true);
    if (i >= body.length) return out;
    const k = key(body, i);
    if (!k) return null;
    i = skip(body, k[1], false);
    if (body[i] !== "=") return null;
    const v = value(body, skip(body, i + 1, false));
    if (!v) return null;
    out[k[0].join(".")] = v[0];
    i = skip(body, v[1], false);
    if (i < body.length && body[i] !== "\n" && body[i] !== "\r") return null;
  }
}
