// 手机端那个轻量 Markdown 解析器:agent 写的 `![](…)` 不许变成一个点不开的链接。
//
// 这个渲染器压根不画图(web 那套「说那句话时的快照」配对、快照接口手机上都没有),而 agent
// 写的目的地是**它自己机器上的路径**(`output/shot.png`)。按链接解析会得到一个点下去只能
// 静默失败的死链接,外加一个孤零零的「!」—— 看不见图是功能没做,但不该表现成「看着像能点」。
import assert from "node:assert/strict";
import { parseInline } from "../src/lib/markdown.ts";

assert.deepEqual(
  parseInline("看这张：![预览](output/shot.png) 完了"),
  [{ text: "看这张：" }, { text: "预览" }, { text: " 完了" }],
  "图片只留 alt 文字,不给 href",
);
// 空 alt:留一个空 span —— 一个 span 都没有时解析器会原样返回整行(于是满屏 Markdown 原文)。
assert.deepEqual(parseInline("![](output/shot.png)"), [{ text: "" }]);
// 真链接照旧可点。
assert.deepEqual(
  parseInline("文档见 [说明](https://example.invalid/a)"),
  [{ text: "文档见 " }, { text: "说明", href: "https://example.invalid/a" }],
);
// 行内代码里的写法示例照旧是代码(`code` 永远先赢)。
assert.deepEqual(
  parseInline("`![示例](a.png)` 不算"),
  [{ text: "![示例](a.png)", code: true }, { text: " 不算" }],
);
// 图片规则要排在链接之前:反过来的话 `![a](x)` 会被当成「!」加一个链接。
assert.deepEqual(parseInline("![a](x) [b](y)"), [{ text: "a" }, { text: " " }, { text: "b", href: "y" }]);

// 站外图片留一个可点的链接:它在手机浏览器里真打得开 —— 旧实现唯一做对的那一半,别跟着
// 本机路径一起砍掉(审查第 3 轮 N1)。
assert.deepEqual(
  parseInline("![远程图](https://example.invalid/a.png)"),
  [{ text: "远程图", href: "https://example.invalid/a.png" }],
);
// 协议相对的补成 https;alt 空着就把网址本身当文字,否则没有东西可点。
assert.deepEqual(
  parseInline("![](//cdn.example.invalid/a.png)"),
  [{ text: "https://cdn.example.invalid/a.png", href: "https://cdn.example.invalid/a.png" }],
);
// `file:`、`data:` 和绝对路径在手机上都没有那个文件,点下去只会静默失败 —— 仍然只留 alt。
for (const destination of ["file:///Users/fjh/a.png", "data:image/png;base64,AAAA", "/Users/fjh/a.png"]) {
  assert.deepEqual(parseInline(`![本机](${destination})`), [{ text: "本机" }], destination);
}

console.log("手机端行内解析回归通过(图片不再变成死链接)");
