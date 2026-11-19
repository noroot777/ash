// R 键「我说过的话」的纯逻辑回归：
//   pickRevealInput —— 点开一句之后，会话里认哪一颗气泡（出处 → 时刻 → 正文）
//   recallOrder / recallMembers / recallTaskRows —— 左边的顺序（同侧栏屏幕）、各自连带哪几条、筛的时候留谁
//   recallBlocks / dayLabel / highlightParts —— 右边一串话怎么分段、命中的词画得对
// 跑：npm -w web run test:recall
import assert from "node:assert/strict";
import type { TaskListItem } from "@navi/shared";
import type { UserMessage } from "@navi/shared/user-messages";
import { REQUIREMENT_INPUT_ID, conversationInputs, type ConversationInput } from "../src/task-detail/conversationInputs.ts";
import { pickRevealInput, type MessageRevealRequest } from "../src/search/messageReveal.ts";
import { dayLabel, highlightParts, messageMatches, openDecision, recallBlocks, recallMembers, recallOrder, recallTaskRows } from "../src/recall/recallModel.ts";

// ── 认气泡 ──────────────────────────────────────────────────────────────────

// 气泡的出处从会话条目一路带进输入导航（conversationInputs），落点靠它对号入座。
const inputs: ConversationInput[] = conversationInputs({ text: "原始需求", at: "2026-11-01T00:00:00.000Z" }, [
  { kind: "user", id: "rec:s1:3", text: "第一次说继续", at: "2026-11-01T01:00:00.000Z", sessionId: "s1", sources: [{ sessionId: "s1", index: 3 }] },
  { kind: "user", id: "persisted:user:s1:7", text: "第二句", at: "2026-11-01T02:00:00.000Z", sessionId: "s1", sources: [{ sessionId: "s1", index: 7 }] },
  // 实时到达、还没落盘的：只有会话和时刻。
  { kind: "user", id: "live-1", text: "刚发的", at: "2026-11-01T03:00:00.000Z", sessionId: "s2" },
  // 老会话没写时刻（服务端那边退回了会话开始时刻），只能靠正文。
  { kind: "user", id: "old", text: "老会话里的一句很长很长的话", sessionId: "s0", sources: [{ sessionId: "s0", index: 1 }] },
  { kind: "user", id: "dup-1", text: "继续", at: "2026-11-01T04:00:00.000Z", sessionId: "s3" },
  { kind: "user", id: "dup-2", text: "继续", at: "2026-11-01T05:00:00.000Z", sessionId: "s3" },
]);
assert.deepEqual(inputs[1]?.source, { sessionId: "s1", index: 3 }, "出处跟着输入一起交出来");
assert.equal(inputs[3]?.source, undefined, "没落盘的没有出处");

const request = (fields: Partial<MessageRevealRequest>): MessageRevealRequest => ({
  taskId: "t", sessionId: "s1", index: null, at: "", text: "", truncated: false, expires: Date.now() + 1000, ...fields,
});
assert.equal(pickRevealInput(inputs, request({ sessionId: null, index: null }))?.id, REQUIREMENT_INPUT_ID, "原始需求");
assert.equal(pickRevealInput(inputs, request({ sessionId: "s1", index: 7, at: "不对的时刻" }))?.id, "persisted:user:s1:7", "出处对上就是它，不看时刻");
assert.equal(pickRevealInput(inputs, request({ sessionId: "s2", index: 0, at: "2026-11-01T03:00:00.000Z", text: "刚发的" }))?.id, "live-1", "没有出处的按会话 + 时刻认");
assert.equal(
  pickRevealInput(inputs, request({ sessionId: "s0", index: 9, at: "2026-10-01T00:00:00.000Z", text: "老会话里的一句很长…", truncated: true }))?.id,
  "old",
  "出处、时刻都对不上的老会话按正文认（截过的比开头）",
);
assert.equal(pickRevealInput(inputs, request({ sessionId: "s3", index: 0, at: "别的时刻", text: "继续" }))?.id, "dup-2", "同一句话说过好几次认最近那次");
assert.equal(pickRevealInput(inputs, request({ sessionId: "s9", index: 0, at: "x", text: "从没说过" })), null, "认不出来就不落");
assert.equal(pickRevealInput(inputs.filter((input) => input.id !== REQUIREMENT_INPUT_ID), request({ sessionId: null })), null, "没画原始需求就不硬落");

// ── 左边：任务 ──────────────────────────────────────────────────────────────

const task = (id: string, fields: Partial<TaskListItem> = {}): TaskListItem =>
  ({ id, title: id, parentId: null, dispatchedBy: null, createdAt: "2026-11-01T00:00:00.000Z", ...fields }) as TaskListItem;
const order = [task("lead", { title: "团队调度" }), task("solo", { title: "改按钮颜色" })];
const all = [
  ...order,
  task("worker", { parentId: "lead", title: "执行者甲", createdAt: "2026-11-02T00:00:00.000Z" }),
  task("derived", { dispatchedBy: "worker", title: "派出去的子任务", createdAt: "2026-11-03T00:00:00.000Z" }),
  task("archived-child", { dispatchedBy: "solo", archived: true, title: "归档的子任务" }),
  task("orphan", { dispatchedBy: "gone" }),
  task("loop-a", { dispatchedBy: "loop-b" }),
  task("loop-b", { dispatchedBy: "loop-a" }),
];
const members = recallMembers(order, all);
assert.deepEqual(members.get("lead"), ["lead", "worker", "derived"], "执行者、执行者派出去的都算在调度那一行上，按创建先后");
assert.deepEqual(members.get("solo"), ["solo", "archived-child"], "归档的子任务也算：里面说过的话还在");
assert.equal([...members.values()].flat().includes("orphan"), false, "够不着左边任何一行的不算");

// 顺序认屏幕：侧栏画出来的先后原样照搬（任务模式按项目分组后的那份），展开着的执行者、收在下面的子任务
// 不单独成行；侧栏没画出来的按模型顺序接在后面；整栏收起就整份用模型顺序。
const orderAll = [...all, task("hidden-old")];
const fallback = ["solo", "lead", "hidden-old", "derived"].map((id) => orderAll.find((item) => item.id === id)!);
const screenIds = (rows: TaskListItem[]) => rows.map((row) => row.id);
assert.deepEqual(screenIds(recallOrder({ kind: "screen", ids: ["lead", "worker", "solo"] }, fallback, orderAll)), ["lead", "solo", "hidden-old"],
  "屏幕上 lead 在 solo 前面就照这个排（模型顺序反过来也不管）；执行者归团队；没画出来的接在后面，收在 lead 下面的 derived 不单独成行");
assert.deepEqual(screenIds(recallOrder({ kind: "offscreen" }, fallback, orderAll)), ["solo", "lead", "hidden-old", "derived"], "侧栏收起：整份用模型顺序");
assert.deepEqual(screenIds(recallOrder({ kind: "screen", ids: ["gone", "solo"] }, [], orderAll)), ["solo"], "屏幕上有、任务表里没有的（远端行之类）跳过");

const titleOf = (id: string) => all.find((item) => item.id === id)?.title ?? "";
const ids = (rows: { task: TaskListItem }[]) => rows.map((row) => row.task.id);
assert.deepEqual(ids(recallTaskRows(order, members, titleOf, "", null)), ["lead", "solo"], "没打字全列，顺序同侧栏");
assert.deepEqual(ids(recallTaskRows(order, members, titleOf, "按钮", null)), ["solo"], "按标题筛");
assert.deepEqual(ids(recallTaskRows(order, members, titleOf, "执行者", null)), ["lead"], "名下那几条的标题也算");
const hit = recallTaskRows(order, members, titleOf, "部署", new Map([["derived", 2], ["worker", 1]]));
assert.deepEqual(hit.map((row) => [row.task.id, row.hits]), [["lead", 3]], "正文对得上的按服务端数，名下几条加在一起");

// ── 右边：一串话 ────────────────────────────────────────────────────────────

const now = new Date(2026, 10, 17, 15, 0);
const at = (month: number, day: number, hour = 12, year = 2026) => new Date(year, month - 1, day, hour).toISOString();
assert.equal(dayLabel(at(11, 17, 0), now), "今天");
assert.equal(dayLabel(at(11, 16, 23), now), "昨天");
assert.equal(dayLabel(at(11, 3), now), "11月3日");
assert.equal(dayLabel(at(12, 30, 12, 2025), now), "2025年12月30日", "往年的带上年份");

const message = (id: string, taskId: string, when: string, text = id): UserMessage => ({
  id, taskId, sessionId: "s", index: 0, text, truncated: false, attachments: [], at: when,
});
const blocks = recallBlocks([
  message("m1", "lead", at(11, 16, 9)),
  message("m2", "lead", at(11, 16, 10)),
  message("m3", "worker", at(11, 17, 9)),
  message("m4", "worker", at(11, 17, 10)),
  message("m5", "lead", at(11, 17, 11)),
], "lead", now);
assert.deepEqual(blocks.map((block) => block.kind === "day" ? `day:${block.label}` : block.kind === "task" ? `task:${block.taskId}` : block.message.id), [
  "day:昨天", "m1", "m2", "day:今天", "task:worker", "m3", "m4", "task:lead", "m5",
], "换一天画段头；一直在它自己身上说不画标题，换到执行者、换回来才画");

assert.equal(messageMatches("把 Deploy 按钮挪到右边", "deploy 右边"), true);
assert.equal(messageMatches("把 Deploy 按钮挪到右边", "deploy 左边"), false, "每个词都得出现");
assert.equal(messageMatches("随便什么", ""), false, "没打字不算命中");

assert.deepEqual(highlightParts("把 Deploy 按钮挪到右边", "deploy 右边"), [
  { text: "把 ", hit: false },
  { text: "Deploy", hit: true },
  { text: " 按钮挪到", hit: false },
  { text: "右边", hit: true },
], "不分大小写，每个词都画");
assert.deepEqual(highlightParts("编辑器", "编辑 编辑器"), [{ text: "编辑器", hit: true }], "同一处有长有短时画长的");
assert.deepEqual(highlightParts("没有命中", ""), [{ text: "没有命中", hit: false }]);

// ── 打开动作 ────────────────────────────────────────────────────────────────

assert.equal(openDecision({ open: true, pending: false, query: "x" }), "open");
assert.equal(openDecision({ open: true, pending: true, query: "x" }), "wait", "列表还是上一问的：不开");
assert.equal(openDecision({ open: false, pending: false, query: "x" }), "drop", "窗口关着：哪个入口都不开");
assert.equal(openDecision({ open: true, pending: true, query: "新词" }, "新词"), "wait", "搜索中按的回车：等结果");
assert.equal(openDecision({ open: true, pending: false, query: " 新词 " }, "新词"), "open", "结果跟上了：开");
assert.equal(openDecision({ open: false, pending: false, query: "新词" }, "新词"), "drop", "搜索中按回车再关窗口：关窗口让搜索中结束了，也不能开上一问的");
assert.equal(openDecision({ open: true, pending: false, query: "又改了" }, "新词"), "drop", "回车之后词又改了：那下回车作废");

console.log("recall tests passed");
