import assert from "node:assert/strict";
import { applyFileMention, fileMentionToken } from "../src/lib/fileMention.ts";
import { browseRows, searchRows, treeKeyAction } from "../src/lib/fileMentionTree.ts";

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

// ── 列表长什么形状：浏览态是树，搜索态按目录归堆 ─────────────────────────────
const dir = (path) => ({ path, name: path.slice(path.lastIndexOf("/") + 1), dir: path.slice(0, Math.max(0, path.lastIndexOf("/"))), kind: "dir" });
const file = (path) => ({ path, name: path.slice(path.lastIndexOf("/") + 1), dir: path.slice(0, Math.max(0, path.lastIndexOf("/"))), kind: "file" });

const levels = new Map([
  ["", [dir("web"), file("README.md")]],
  ["web", [dir("web/src"), file("web/index.html")]],
  ["web/src", [file("web/src/main.tsx")]],
]);
assert.deepEqual(
  browseRows("", levels, new Set()).map((row) => [row.hit.path, row.depth, row.expanded]),
  [["web", 0, false], ["README.md", 0, false]],
  "没展开就只有这一层，子目录的东西一条都不该冒出来",
);
assert.deepEqual(
  browseRows("", levels, new Set(["web", "web/src"])).map((row) => [row.hit.path, row.depth]),
  [["web", 0], ["web/src", 1], ["web/src/main.tsx", 2], ["web/index.html", 1], ["README.md", 0]],
  "展开的目录把子项就地挂在自己下面，缩进逐层加深",
);
assert.equal(
  browseRows("", levels, new Set(["web/src"]))[0].expanded,
  false,
  "爹没展开，儿子展不展开都不该影响这一层",
);
// 展开了但子项还没到货：这一行要说「展开中」，不然看着像点了没反应
const pending = browseRows("", new Map([["", [dir("web")]]]), new Set(["web"]));
assert.equal(pending[0].loading, true);

// 搜索态：同一个目录的命中挤在一个目录头下面，组的先后跟着第一条命中走
assert.deepEqual(
  searchRows([file("src/api.ts"), file("src/lib/a.ts"), file("src/b.ts"), file("README.md")])
    .map((row) => [row.hit.path, row.depth, row.hit.kind]),
  [
    ["src", 0, "dir"], ["src/api.ts", 1, "file"], ["src/b.ts", 1, "file"],
    ["src/lib", 0, "dir"], ["src/lib/a.ts", 1, "file"],
    ["README.md", 0, "file"],
  ],
  "同一目录的命中要聚在一起（src/b.ts 跟到 src 那一堆里），根下的文件不需要组头",
);
assert.equal(
  searchRows([dir("src/lib"), file("src/lib/a.ts")]).length,
  2,
  "目录本身也命中时，它就当组头，不该出现两次",
);

// ── 左右键：展开 / 收起 / 跳回上一层，全都不碰状态，只回动作 ─────────────────
const tree = browseRows("", levels, new Set());
assert.deepEqual(treeKeyAction("ArrowRight", tree, 0), { type: "expand", dir: "web" }, "收着的目录：右键展开");
const opened = browseRows("", levels, new Set(["web", "web/src"]));
assert.deepEqual(treeKeyAction("ArrowRight", opened, 0), { type: "select", index: 1 }, "展开着的目录：右键进到第一个子项");
assert.deepEqual(treeKeyAction("ArrowLeft", opened, 1), { type: "collapse", dir: "web/src" });
assert.deepEqual(treeKeyAction("ArrowLeft", opened, 2), { type: "select", index: 1 }, "文件上按左键跳回它爹");
assert.equal(treeKeyAction("ArrowLeft", tree, 1), null, "最外层的文件没有爹，左键让给光标");
assert.equal(treeKeyAction("ArrowRight", opened, 4), null, "文件上的右键也让给光标");

console.log("file-mention: ok");
