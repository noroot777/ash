// 「拿仓库源码当断言对象」的测试统一从这里读文件。
//
// 起因(2026-08-28):Windows 上 git 默认 core.autocrlf=true,检出到工作区的每一行都是
// CRLF;而断言里的跨行正则是照 LF 写的 —— `X\n\s+Y` 碰到 `X\r\n` 当场失配(`\n` 前面
// 多了个 `\r`),于是同一份代码 macOS 全绿、Windows 上 `npm -w web run build` 直接断在
// test:remote-task 那一步,连带 npm run restart 起不来。
// 读进来先把 CRLF 归一成 LF,断言就只需要认一种行尾。
//
// 另一层在 .gitattributes(`* text=auto eol=lf`):那条管**新检出**,这里管**已经是 CRLF
// 的旧工作区** —— 已经落盘的文件不会因为加了 .gitattributes 就自己变回 LF。
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

export const normalizeEol = (text) => text.replace(/\r\n/g, "\n");

export const readSource = (target) => normalizeEol(readFileSync(target, "utf8"));

export const readSourceAsync = async (target) => normalizeEol(await readFile(target, "utf8"));

// ── 顺着 import 图读一条「职责链」 ──────────────────────────────────────────────
//
// 这类断言钉的是「这条链上有没有这段逻辑」,可写法上往往退化成「某个文件里有没有这段
// 文字」。项目同时有「单文件不超过 700 行、写到上限就按职责拆」的硬规则,于是一次**合规
// 拆分**就能把它们成批打红,而行为一个字没变:2026-11-02 普查里 `test-session-lost` 与
// `test-ash-mcp-reach` 两条同时红,责任笔是同一个 `9efd0081` —— 拆出去的
// `turn-session-pick.ts` / `turn-workspace-pick.ts` 连注释都写明了「这段搬哪儿去了」,
// 而失败信息长得像真缺陷(「没在起跑前识别受影响的 Codex 会话」)。
//
// 所以入口给文件,范围按 import 走:断言在拼出来的那一份上做,拆分不再改变结论。
//
// `depth` 刻意留小(默认 1 = 只跟一层):拼得越深,断言越容易在一个无关模块里碰巧命中,
// 契约就白钉了。拆分通常只是把一段挪进**入口直接 import 的**新文件,一层够用;确有需要
// 再按那条链的实际层数调。
//
// 只跟相对说明符(`./x.js`、`../y/z.js`),包名一律不跟 —— 那些不是这条链的一部分。
// 说明符按 TS 的习惯写成 `.js`,磁盘上是 `.ts`,所以两种后缀都试。
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SPECIFIER = /(?:\bfrom|\bimport)\s*\(?\s*["'](\.[^"']+)["']/g;

const resolveLocal = (from, specifier) => {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base.replace(/\.js$/, ".ts"), base, `${base}.ts`, resolve(base, "index.ts")]) {
    if (existsSync(candidate) && !candidate.endsWith("/")) return candidate;
  }
  return null;
};

export const readSourceChain = (entry, depth = 1) => {
  const seen = new Set();
  const parts = [];
  const visit = (file, left) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readSource(file);
    parts.push(`// ──── ${file} ────\n${source}`);
    if (left <= 0) return;
    for (const [, specifier] of source.matchAll(SPECIFIER)) {
      const next = resolveLocal(file, specifier);
      if (next) visit(next, left - 1);
    }
  };
  visit(resolve(entry), depth);
  return parts.join("\n");
};
