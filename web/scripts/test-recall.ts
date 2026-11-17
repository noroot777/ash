// R 键「我说过的话」的纯逻辑回归：
//   pickRevealInput —— 点开一句之后，会话里认哪一颗气泡（出处 → 时刻 → 正文）
//   recallRows / dayLabel / rowText / highlightParts —— 列表按天分段、命中的词露得出来、画得对
// 跑：npm -w web run test:recall
import assert from "node:assert/strict";
import type { UserMessage } from "@ash/shared/user-messages";
import { REQUIREMENT_INPUT_ID, conversationInputs, type ConversationInput } from "../src/task-detail/conversationInputs.ts";
import { pickRevealInput, type MessageRevealRequest } from "../src/search/messageReveal.ts";
import { dayLabel, highlightParts, plainSnippet, recallRows, rowText } from "../src/recall/recallModel.ts";

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

// ── 列表 ────────────────────────────────────────────────────────────────────

const now = new Date(2026, 10, 17, 15, 0);
const at = (month: number, day: number, hour = 12, year = 2026) => new Date(year, month - 1, day, hour).toISOString();
assert.equal(dayLabel(at(11, 17, 0), now), "今天");
assert.equal(dayLabel(at(11, 16, 23), now), "昨天");
assert.equal(dayLabel(at(11, 3), now), "11月3日");
assert.equal(dayLabel(at(12, 30, 12, 2025), now), "2025年12月30日", "往年的带上年份");

const message = (id: string, when: string, text: string, attachments: string[] = []): UserMessage => ({
  id, taskId: "t", sessionId: "s", index: 0, text, truncated: false, attachments, at: when,
});
const rows = recallRows([
  message("a", at(11, 17, 14), "今天下午"),
  message("b", at(11, 17, 9), "今天上午"),
  { ...message("b2", at(11, 17, 8), "另一个任务里"), taskId: "t2" },
  message("c", at(11, 16, 20), "昨晚"),
  message("d", at(11, 3), "更早"),
], now);
assert.deepEqual(rows.map((row) => row.day), ["今天", null, null, "昨天", "11月3日"], "每一天只在第一行上画段头");
assert.deepEqual(rows.map((row) => row.task), [true, false, true, true, true], "同一任务连着说的几句只画一次任务名；换任务、换天都重画");

const fileName = (path: string) => path.split("/").at(-1)!;
assert.equal(rowText(message("x", at(11, 17), "  第一行\n\n第二行  "), fileName), "第一行 第二行", "空白压成一个空格");
assert.equal(rowText(message("x", at(11, 17), "", ["/up/a.png", "/up/b.pdf"]), fileName), "a.png、b.pdf", "只发了附件的报附件名");
const longText = `${"前".repeat(80)}关键词在后面`;
const excerpt = rowText(message("x", at(11, 17), longText), fileName, "关键词");
assert.ok(excerpt.startsWith("…") && excerpt.includes("关键词"), "筛中的词在后面时，那一行从词前面一点起头");
assert.equal(rowText(message("x", at(11, 17), "关键词在开头"), fileName, "关键词"), "关键词在开头", "词就在开头附近的照原样");

assert.deepEqual(highlightParts("把 Deploy 按钮挪到右边", "deploy 右边"), [
  { text: "把 ", hit: false },
  { text: "Deploy", hit: true },
  { text: " 按钮挪到", hit: false },
  { text: "右边", hit: true },
], "不分大小写，每个词都画");
assert.deepEqual(highlightParts("编辑器", "编辑 编辑器"), [{ text: "编辑器", hit: true }], "同一处有长有短时画长的");
assert.deepEqual(highlightParts("没有命中", ""), [{ text: "没有命中", hit: false }]);

assert.equal(
  plainSnippet("## 改法\n\n| 情况 | 改前 |\n|---|---|\n| a | b |\n\n- **单条任务**：看 `web/a.ts`，见 [文档](https://x)\n> 引一句"),
  "改法 单条任务：看 web/a.ts，见 文档 引一句",
  "由头那段压成纯文本：表格行不要，记号和链接地址去掉",
);

console.log("recall tests passed");
