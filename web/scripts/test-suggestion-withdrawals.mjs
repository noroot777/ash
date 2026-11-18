// 智能体收回了挂在回复框顶上的建议任务：为什么不见了，是会话里收回那一刻的一句小灰字
// （src/task-detail/suggestions/withdrawalNotes.ts）。这句话从任务上那份收回记录来（跟拿掉那一件同一笔落库），
// 不从会话正文来：记录在，这一句就在。
import assert from "node:assert/strict";
import { withdrawalNotes } from "../src/task-detail/suggestions/withdrawalNotes.ts";
import { interleaveAsides } from "../src/task-detail/feedAsides.ts";

assert.deepEqual(withdrawalNotes(undefined), [], "没收回过：什么都不画");

const notes = withdrawalNotes([
  { id: "s3", title: "补文档", reason: "需求取消了", at: "2026-11-18T08:00:00.000Z" },
  { id: "s1", title: "修好那条红测试", reason: "已经在本任务里顺手修了", at: "2026-11-18T07:40:00.000Z" },
  { id: "s2", title: "清掉旧开关", reason: "开关已经随上一条删了", at: "2026-11-18T07:40:00.000Z" },
]);
assert.deepEqual(notes.map((note) => [note.at, note.footnote.parts.map((part) => part.view.text)]), [
  ["2026-11-18T07:40:00.000Z", ["收回了建议任务「修好那条红测试」：已经在本任务里顺手修了", "收回了建议任务「清掉旧开关」：开关已经随上一条删了"]],
  ["2026-11-18T08:00:00.000Z", ["收回了建议任务「补文档」：需求取消了"]],
], "一次收回一句（同一次的几件并在一行），按先后排；标题和原因都直接写出来");
assert.equal(new Set(notes.map((note) => note.key)).size, notes.length, "每一句有自己的身份");
for (const part of notes.flatMap((note) => note.footnote.parts)) {
  assert.deepEqual([part.view.tier, part.view.tone, part.view.detail], ["alert", "neutral", null], "摆在明面上、不带颜色、没有要点开才看得到的半句");
}
assert.equal(notes.every((note) => note.footnote.live === false), true, "不是坏消息，字前没有那颗圆点");

// 落在会话里的哪一处：收回它的那一回合之后、下一句话之前。
const rows = [{ id: "u0", at: "2026-11-18T07:30:00.000Z" }, { id: "a1", at: "2026-11-18T07:31:00.000Z" }, { id: "u1", at: "2026-11-18T07:50:00.000Z" }];
const feed = interleaveAsides(rows, notes.map((note) => ({ key: note.key, at: note.at, node: null })), (row) => row.at);
assert.deepEqual(feed.map((entry) => entry.row?.id ?? entry.aside.key), ["u0", "a1", "withdrawn:s1", "u1", "withdrawn:s3"]);

// 这一层不截、不折叠：服务端给多少条就写多少句——离开很久、期间收回过很多次，回来时最早那一句也还在。
const many = withdrawalNotes(Array.from({ length: 60 }, (_, index) => ({
  id: `m${index}`, title: `第 ${index} 件`, reason: `原因 ${index}`, at: new Date(Date.UTC(2026, 10, 18, 9, 0, index)).toISOString(),
})));
assert.equal(many.length, 60);
assert.equal(many[0].footnote.parts[0].view.text, "收回了建议任务「第 0 件」：原因 0");
assert.equal(interleaveAsides(rows, many.map((note) => ({ key: note.key, at: note.at, node: null })), (row) => row.at).filter((entry) => entry.aside).length, 60);

console.log("suggestion-withdrawals ok");
