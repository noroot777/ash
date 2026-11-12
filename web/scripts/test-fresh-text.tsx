// 放字（docs/ui-ux-audit run-4）：新放出来的字一段一颗 span，刚放的带淡入、早放的是空壳。跑：npm -w web run test:fresh-text
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownBody } from "../src/components/MarkdownBody.tsx";
import { rehypeFreshText } from "../src/components/freshText.ts";

const render = (text: string, marks: { from: number; at: number }[], now: number) =>
  renderToStaticMarkup(<MarkdownBody text={text} layout={{ inserts: [], fresh: { marks, now } }} />);

// 挂上时就在的字不包；之后每一段各一颗 span，只有 280ms 内放出来的那段淡入。
const text = "先前的字。后来的一段，再后来的一段";
const html = render(text, [{ from: 5, at: 0 }, { from: 11, at: 900 }], 1000);
assert.match(html, /<p>先前的字。<span>后来的一段，<\/span><span class="is-fresh-text">再后来的一段<\/span><\/p>/);

// 跨块：一段新字从上一段落尾一直放到下一段落，两边各自包。
const twoParas = "第一段\n\n第二段";
const split = render(twoParas, [{ from: 2, at: 1000 }], 1000);
assert.match(split, /<p>第一<span class="is-fresh-text">段<\/span><\/p>/);
assert.match(split, /<p><span class="is-fresh-text">第二段<\/span><\/p>/);

// 行内代码、代码块整块出现：高亮拿的是原文，不能被切成几颗 span（直接喂一棵 hast，
// 行内代码在服务端渲染里要读浏览器里的文件定位，走不了 renderToStaticMarkup）。
const at = (start: number, value: string) => ({ type: "text", value, position: { start: { offset: start }, end: { offset: start + value.length } } });
const tree = { type: "root", children: [
  { type: "element", tagName: "p", children: [at(0, "看 "), { type: "element", tagName: "code", children: [at(3, "npm test")] }, at(12, " 这里")] },
  { type: "element", tagName: "pre", children: [{ type: "element", tagName: "code", children: [at(20, "const a = 1;")] }] },
] };
rehypeFreshText([{ from: 0, at: 1000 }], 1000)()(tree);
const [para, pre] = tree.children as { children: { type: string; tagName?: string; children?: unknown[] }[] }[];
assert.deepEqual(para!.children.map((node) => node.tagName ?? node.type), ["span", "code", "span"]);
assert.deepEqual((para!.children[1]!.children as { type: string }[]).map((node) => node.type), ["text"]);
assert.equal(JSON.stringify(pre).includes("is-fresh-text"), false);

// 源码和显示长度对不上（转义）就不切，整段照常出。
const escaped = render("a\\*b 后面", [{ from: 2, at: 1000 }], 1000);
assert.match(escaped, /a\*b 后面/);

// 没有放字的时候一颗 span 都不加。
assert.doesNotMatch(renderToStaticMarkup(<MarkdownBody text={text} layout={{ inserts: [] }} />), /<span/);

console.log("fresh text: marks split into stable spans, only recent ones fade, code and escapes stay whole");
