// 「我说过的话」（R 键那张表）的纯函数回归：不碰库也不摸盘。
//   utterancesIn —— 一份会话正文里哪几句算我说的、段号跟页面上气泡的出处对不对得上
//   pageMessages —— 新的在前、按词筛（正文或任务标题）、游标翻页不重不漏
//   contextAround —— 右边那栏的上下文：我在接它哪句话、它这一轮最后怎么回的
// 跑：npm -w server run test:user-messages
import assert from "node:assert/strict";
import { parseSessionSpans } from "@ash/shared/session-output";
import {
  CONTEXT_AFTER_CAP,
  CONTEXT_BEFORE_CAP,
  MESSAGE_TEXT_CAP,
  contextAround,
  compareNewestFirst,
  decodeCursor,
  encodeCursor,
  pageMessages,
  toIndexed,
  utterancesIn,
  type IndexedMessage,
} from "../src/user-messages-pick.ts";

const turn = (t: string, text: string, extra: Record<string, unknown> = {}) =>
  `\x1e${JSON.stringify({ t, agent: "claude", text, at: "2026-11-01T01:00:00.000Z", ...extra })}`;

// ── 摘发言 ──────────────────────────────────────────────────────────────────

const output = [
  "agent 的第一段回复",
  turn("user", "帮我把按钮改成黑的", { at: "2026-11-01T02:00:00.000Z" }),
  "agent 又说了点什么",
  turn("user", "【自动验证未通过 · 第 1 轮】", { by: "system" }),
  turn("system", "继续（从中断处）"),
  turn("user", "删掉的这句", { deleted: true }),
  turn("user", "没写时刻的一句", { at: undefined }),
].join("\n");
const said = utterancesIn(output);
assert.deepEqual(said.map((one) => one.raw), ["帮我把按钮改成黑的", "没写时刻的一句"], "只收我打的字：代写、系统注记、删掉的都不算");
const spans = parseSessionSpans(output);
for (const one of said) {
  assert.equal(spans[one.index]?.seg.text, one.raw, "段号就是 parseSessionSpans 的下标（含删掉的段），页面拿它认气泡");
}
assert.equal(said[0]?.at, "2026-11-01T02:00:00.000Z");
assert.equal(said[1]?.at, null, "没时刻就如实给 null，由调用方退回会话开始时刻");

// ── 展示正文 ────────────────────────────────────────────────────────────────

assert.equal(toIndexed({ id: "a", taskId: "t", sessionId: null, index: null, at: "x" }, "   "), null, "空白不成一条");
const long = toIndexed({ id: "a", taskId: "t", sessionId: null, index: null, at: "x" }, `开头${"字".repeat(MESSAGE_TEXT_CAP)}结尾的关键词`)!;
assert.equal(long.truncated, true);
assert.ok(long.text.length <= MESSAGE_TEXT_CAP + 1, "交出去的正文截断");
assert.ok(long.full.endsWith("结尾的关键词"), "筛的时候用的是整段，截掉的部分照样搜得到");

// ── 排序、筛、翻页 ──────────────────────────────────────────────────────────

const message = (id: string, at: string, text: string, taskId = "t1"): IndexedMessage =>
  toIndexed({ id, taskId, sessionId: "s", index: 0, at }, text)!;
const all = [
  message("m1", "2026-11-01T01:00:00.000Z", "最早的一句"),
  message("m2", "2026-11-02T01:00:00.000Z", "部署脚本又挂了", "t2"),
  message("m3", "2026-11-03T01:00:00.000Z", "把 Deploy 按钮挪到右边"),
  message("m4", "2026-11-03T01:00:00.000Z", "同一时刻的另一句"),
  message("m5", "2026-11-04T01:00:00.000Z", "最新的一句"),
].sort(compareNewestFirst);
assert.deepEqual(all.map((one) => one.id), ["m5", "m4", "m3", "m2", "m1"], "新的在前，同一时刻按 id 定死顺序");

const titles: Record<string, string> = { t1: "界面改版", t2: "上线流程" };
const titleOf = (taskId: string) => titles[taskId] ?? "";

// 一页两条、一路翻到底：不重不漏，最后一页 next 为 null。
const seen: string[] = [];
let cursor: string | null = null;
for (let guard = 0; guard < 10; guard += 1) {
  const page = pageMessages(all, titleOf, { query: "", cursor, limit: 2 });
  seen.push(...page.messages.map((one) => one.id));
  cursor = page.next;
  if (!cursor) break;
}
assert.deepEqual(seen, ["m5", "m4", "m3", "m2", "m1"], "游标翻页不重不漏");
assert.equal(pageMessages(all, titleOf, { query: "", limit: 5 }).next, null, "正好装满最后一页时不该再给下一页");

// 翻页的工夫里又说了一句新的：第二页照旧接着上一页的末尾，不会把已经看过的那条再给一遍。
const first = pageMessages(all, titleOf, { query: "", limit: 2 });
const grown = [message("m6", "2026-11-05T01:00:00.000Z", "翻页时新说的"), ...all];
assert.deepEqual(pageMessages(grown, titleOf, { query: "", cursor: first.next, limit: 2 }).messages.map((one) => one.id), ["m3", "m2"]);

assert.deepEqual(pageMessages(all, titleOf, { query: "deploy", limit: 10 }).messages.map((one) => one.id), ["m3"], "不分大小写");
assert.deepEqual(pageMessages(all, titleOf, { query: "部署  挂了", limit: 10 }).messages.map((one) => one.id), ["m2"], "多个词都得出现");
assert.deepEqual(pageMessages(all, titleOf, { query: "上线 脚本", limit: 10 }).messages.map((one) => one.id), ["m2"], "词可以落在任务标题里");
assert.deepEqual(pageMessages(all, titleOf, { query: "没有这个词", limit: 10 }), { messages: [], next: null });

assert.equal(decodeCursor("不是游标"), null, "坏游标当没给");
assert.deepEqual(decodeCursor(encodeCursor({ at: "a", id: "b" })), { at: "a", id: "b" });

// ── 上下文 ──────────────────────────────────────────────────────────────────

const chat = [
  "我先看看需求。",
  "首轮结论：按钮已经改好。",
  turn("user", "再把颜色调深一点"),
  "我先看一下样式。",
  turn("system", "第 1 轮审查开始", { aside: true }),
  "颜色已经调深，提交了。",
  turn("user", "好的"),
  turn("user", "【自动验证未通过 · 第 1 轮】", { by: "system" }),
  "按报告修了。",
].join("\n");
const chatSpans = parseSessionSpans(chat);
const indexOf = (text: string) => chatSpans.findIndex(({ seg }) => seg.text === text);

const middle = contextAround(chat, indexOf("再把颜色调深一点"));
assert.match(middle.before?.text ?? "", /首轮结论/, "我是在接它最近那段话");
assert.equal(middle.after?.text, "颜色已经调深，提交了。", "回复取这一轮最后那段正文（结论），旁注跳过");

const last = contextAround(chat, indexOf("好的"));
assert.match(last.before?.text ?? "", /颜色已经调深/);
assert.equal(last.after?.text, "按报告修了。", "系统代写的输入（审查打回）不算我开口：回复读到我下一句为止");

const requirement = contextAround(chat, null);
assert.equal(requirement.before, null, "原始需求前面没有东西");
assert.match(requirement.after?.text ?? "", /首轮结论/, "原始需求的回复是会话开头那一轮");

const twice = contextAround([turn("user", "第一句"), turn("user", "紧接着第二句"), "回复"].join("\n"), 1);
assert.equal(twice.before, null, "前面紧挨着的是我自己的话：不算在接它的话");
assert.equal(contextAround([turn("user", "第一句"), "回复", turn("user", "第二句"), "第二个回复"].join("\n"), 0).after?.text, "回复", "回复到我下一句为止，不往后串");

const longReply = `${"第一段".repeat(150)}\n\n${"第二段".repeat(200)}`;
const capped = contextAround([turn("user", "问"), longReply].join("\n"), 0).after!;
assert.equal(capped.truncated, true);
assert.ok(capped.text.length <= CONTEXT_AFTER_CAP, "回复截过");
assert.equal(capped.text, "第一段".repeat(150), "截在段落边界上");
const longBefore = contextAround([`${"开头".repeat(300)}结尾那句`, turn("user", "问")].join("\n"), 1).before!;
assert.ok(longBefore.truncated && longBefore.text.length <= CONTEXT_BEFORE_CAP && longBefore.text.endsWith("结尾那句"), "前面那段留的是末尾");
const table = `| 情况 | 改前 |\n|---|---|\n${"| 一行 | 一格 |\n".repeat(30)}`;
const afterTable = contextAround([`${table}\n\n最后那句结论。`, turn("user", "问")].join("\n"), 1).before!;
assert.equal(afterTable.text, "最后那句结论。", "末尾整段地收：装不下的表格整个不要，不从中间切进去");

const narrated = contextAround([turn("user", "查一下"), "先查哨兵记录：\n\n截图核对一下：\n\n**确实有哨兵在跑。**\n\n细节如下：\n\n- 第一条"].join("\n"), 0).after!;
assert.ok(narrated.text.startsWith("**确实有哨兵在跑。**"), "开头冒号结尾的过程话去掉，露出真正的回答");
assert.ok(narrated.text.includes("细节如下："), "回答中间的冒号句照留");
assert.equal(contextAround([turn("user", "问"), "只有这一句："].join("\n"), 0).after?.text, "只有这一句：", "全是过程话时至少留一段");

console.log("user-messages tests passed");
