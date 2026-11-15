import assert from "node:assert/strict";
import { applyNoteMention, matchNotes, noteExcerpt, noteTitle } from "../src/lib/noteMention.ts";

// `@` 引用随手记的纯函数：哪几条算命中、选中之后正文变成什么。错了不报错，只是带进输入框
// 的东西不对（或者敲路径时回车选中了一条随手记），所以钉在这里。
// 跑：npm -w web run test:note-mention

const note = (id, body, attachments = []) => ({
  id, projectId: "p", body, attachments, taskLinks: [], createdAt: 0, updatedAt: 0,
});
const NOTES = [
  note("a", "部署清单\n先跑迁移\n再重启 API"),
  note("b", "  \n\n登录页的 Bug  \n截图在附件里", ["data/uploads/x.png"]),
  note("c", "Release v1.2 记得改 changelog"),
];

// ── 标题：第一行非空的字 ──────────────────────────────────────────────────────
assert.equal(noteTitle(NOTES[0].body), "部署清单");
assert.equal(noteTitle(NOTES[1].body), "登录页的 Bug", "开头的空行和首尾空白不算标题");
assert.equal(noteTitle("   \n "), "无标题随手记");

// ── 哪几条命中 ────────────────────────────────────────────────────────────────
assert.deepEqual(matchNotes(NOTES, "").map((item) => item.id), ["a", "b", "c"], "刚敲下 @ 就给最近的几条");
assert.deepEqual(matchNotes(NOTES, "迁移").map((item) => item.id), ["a"], "正文任何一行命中都算");
assert.deepEqual(matchNotes(NOTES, "bug").map((item) => item.id), ["b"], "不分大小写");
assert.deepEqual(matchNotes(NOTES, "v1.2").map((item) => item.id), ["c"], "带点的 token 照样能搜随手记");
assert.deepEqual(matchNotes(NOTES, "src/"), [], "token 里有 / 就是在敲路径，随手记整段让位");
assert.equal(
  matchNotes(Array.from({ length: 9 }, (_, at) => note(String(at), `第 ${at} 条`)), "").length,
  5,
  "一屏只列几条，再多就该接着打字缩小范围",
);

// ── 命中不在标题里时补一句命中的那一行 ────────────────────────────────────────
assert.equal(noteExcerpt(NOTES[0].body, "部署"), null, "命中就在标题里，不必再写一遍");
assert.equal(noteExcerpt(NOTES[0].body, ""), null);
assert.equal(noteExcerpt(NOTES[0].body, "重启"), "再重启 API");
assert.equal(
  noteExcerpt("标题\n这是一行很长很长的说明文字，命中在后面：关键字", "关键字"),
  "…字，命中在后面：关键字",
  "长行从命中处往前留一小截，命中不能被挤到看不见",
);

// ── 选中之后正文变成什么 ──────────────────────────────────────────────────────
assert.equal(applyNoteMention("@部署", NOTES[0].body), "部署清单\n先跑迁移\n再重启 API\n", "多行的接一个换行");
assert.equal(applyNoteMention("参考 @v1", NOTES[2].body), "参考 Release v1.2 记得改 changelog ", "单行的接一个空格，前面的字一个不动");
assert.equal(applyNoteMention("@", NOTES[1].body), "登录页的 Bug  \n截图在附件里\n", "首尾空白收掉，`@token` 一个字都不留");
assert.equal(
  applyNoteMention("先看这个\n@登录", NOTES[1].body),
  "先看这个\n登录页的 Bug  \n截图在附件里\n",
);

console.log("note-mention: ok");
