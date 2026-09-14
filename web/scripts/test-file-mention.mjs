import assert from "node:assert/strict";
import { applyFileMention, fileMentionToken } from "../src/lib/fileMention.ts";

// `@` 引用文件的两个纯函数。它们决定「什么时候弹菜单」和「最终发给 CLI 的那行字长什么
// 样」——两件事错了都没有报错，只是 agent 读不到文件，所以钉在这里。
// 跑：npm -w web run test:file-mention

// ── 什么时候算在敲 @ ──────────────────────────────────────────────────────────
assert.equal(fileMentionToken("@"), "", "刚敲下 @ 就该弹（空 token = 列浅层文件）");
assert.equal(fileMentionToken("看看 @src/li"), "src/li");
assert.equal(fileMentionToken("改一下 @web/src/lib/api.ts"), "web/src/lib/api.ts");
assert.equal(fileMentionToken("@a-b_c.tsx"), "a-b_c.tsx", "路径里的 - _ . 都得留在 token 里");
// 反面：不该弹的几种
assert.equal(fileMentionToken("mail me at fjh@example.com"), null, "邮箱不是文件引用");
assert.equal(fileMentionToken("@src/lib 然后呢"), null, "已经敲完并空格了就收起来");
assert.equal(fileMentionToken("没有艾特符号"), null);
assert.equal(fileMentionToken(""), null);

// ── 选中之后正文变成什么 ──────────────────────────────────────────────────────
assert.equal(applyFileMention("看看 @src/li", "src/lib/api.ts"), "看看 @src/lib/api.ts ");
assert.equal(applyFileMention("@", "README.md"), "@README.md ", "空 token 也要被替换掉");
assert.equal(
  applyFileMention("读 @my", "my docs/计划 A.md"),
  '读 @"my docs/计划 A.md" ',
  "带空格的路径必须加引号，否则 agent 只拿到第一个空格之前那一截",
);
// 前面的正文一个字都不能动
assert.equal(
  applyFileMention("先做 A，再看 @api", "src/api.ts"),
  "先做 A，再看 @src/api.ts ",
);
// 连续引用两个文件
assert.equal(
  applyFileMention(applyFileMention("对比 @a", "src/a.ts") + "和 @b", "src/b.ts"),
  "对比 @src/a.ts 和 @src/b.ts ",
);

console.log("file-mention: ok");
