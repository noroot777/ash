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
