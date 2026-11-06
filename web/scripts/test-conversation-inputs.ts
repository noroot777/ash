// 会话左侧输入导航的纯逻辑：哪些话进导航、刻度怎么排、读到哪一条、Q 交给谁。
// 跑法：npm -w web run test:conversation-inputs
import assert from "node:assert/strict";
import {
  REQUIREMENT_INPUT_ID,
  conversationInputAnchor,
  conversationInputHeadline,
  conversationInputs,
} from "../src/task-detail/conversationInputs.ts";
import {
  RAIL_PITCH_MAX,
  TICK_WIDTH,
  TICK_WIDTH_PEAK,
  activeInput,
  nearestTick,
  railPitch,
  tickWidth,
} from "../src/components/conversationInputRailGeometry.ts";
import { registerConversationInputsTarget, toggleConversationInputs } from "../src/components/conversationInputNav.ts";

// ── 哪些话进导航 ────────────────────────────────────────────────────────────
const upload = "/Users/example/code/ash/data/uploads/R4nd0mAbC123-shot.png";
const items = [
  { kind: "agent", id: "a1", text: "我先看看。" },
  { kind: "user", id: "u1", text: "改成 Q 吧", at: "2026-11-03T09:07:35.669Z" },
  // 哨兵投喂、审查打回：系统代写，占着真人回合但不是我说的。
  { kind: "user", id: "monitor", text: "【哨兵事件】回归跑完了", bySystem: true },
  { kind: "user", id: "review", text: "【自由工作流审查未通过 · 第 1 轮】请按报告修复", bySystem: true },
  // 老会话里没有 by 标记的代写：只能靠前缀认。
  { kind: "user", id: "answer", text: "【答复】用方案 A" },
  { kind: "user", id: "legacy-verify", text: "【自动验证未通过】第 2 轮" },
  { kind: "event", id: "e1", text: "已预约审查" },
  { kind: "user", id: "blank", text: "   " },
  {
    kind: "user",
    id: "u2",
    text: `看这张图\n\n[用户附带的文件，请用 Read 工具查看以下本地文件]\n- ${upload}`,
    attachments: ["/tmp/extra.pdf"],
    at: "2026-11-03T09:12:25.865Z",
  },
];

const inputs = conversationInputs({ text: "原始需求正文\n第二行", at: "2026-11-03T08:40:00.000Z" }, items);
assert.deepEqual(inputs.map((input) => input.id), [REQUIREMENT_INPUT_ID, "u1", "u2"], "原始需求打头，只收我自己打的字");
assert.equal(inputs[0]!.text, "原始需求正文\n第二行");
assert.equal(inputs[0]!.at, "2026-11-03T08:40:00.000Z");
assert.deepEqual(inputs[2], {
  id: "u2",
  text: "看这张图",
  attachments: [upload, "/tmp/extra.pdf"],
  at: "2026-11-03T09:12:25.865Z",
}, "附件清单从正文里剥出来，跟条目自带的附件合在一起");

// 原始需求拿不到（列表项不带正文）或是空的：只排追问。
assert.deepEqual(conversationInputs(null, items).map((input) => input.id), ["u1", "u2"]);
assert.deepEqual(conversationInputs({ text: "  " }, items).map((input) => input.id), ["u1", "u2"]);
// 只贴了图、一个字没打的原始需求照样算一格。
const imageOnly = conversationInputs({ text: `[用户附带的文件，请用 Read 工具查看以下本地文件]\n- ${upload}` }, []);
assert.deepEqual(imageOnly.map((input) => [input.id, input.text, input.attachments.length]), [[REQUIREMENT_INPUT_ID, "", 1]]);

// 一句话认出它：正文第一行；只发了附件就报附件名（去掉上传时加的随机前缀）。
assert.equal(conversationInputHeadline(inputs[0]!), "原始需求正文");
assert.equal(conversationInputHeadline({ id: "x", text: "\n\n  第三行才有字\n后面", attachments: [] }), "第三行才有字");
assert.equal(conversationInputHeadline(imageOnly[0]!), "shot.png");

assert.deepEqual(conversationInputAnchor("persisted:user:s1:3"), { "data-conversation-input": "persisted:user:s1:3" });

// ── 刻度怎么排 ──────────────────────────────────────────────────────────────
assert.equal(railPitch(5, 600), RAIL_PITCH_MAX, "格子少就按最大间距排成一簇");
assert.equal(railPitch(101, 400), 4, "排不下就压密到正好铺满");
assert.ok(Math.abs(railPitch(10_000, 400) * 9_999 - 400) < 1e-6, "再多也整条排进会话区，不伸出去");
assert.equal(railPitch(5, 0), 0, "会话区还没量出高度");
assert.equal(railPitch(1, 400), RAIL_PITCH_MAX);

assert.equal(nearestTick(-30, 5, 8), 0, "指在第一格上面也算第一格");
assert.equal(nearestTick(11.9, 5, 8), 1);
assert.equal(nearestTick(12.1, 5, 8), 2);
assert.equal(nearestTick(999, 5, 8), 4, "指在末格下面也算末格");
assert.equal(nearestTick(0, 0, 8), -1);
assert.equal(nearestTick(30, 5, 0), 0, "间距压成 0 也不出 NaN");

assert.equal(tickWidth(40, null), TICK_WIDTH, "没指在导航条上时一律平时长度");
assert.equal(tickWidth(40, 40), TICK_WIDTH_PEAK, "正对着的那一格最长");
const near = tickWidth(48, 40);
const far = tickWidth(80, 40);
assert.ok(near < TICK_WIDTH_PEAK && near > far && far > TICK_WIDTH, "离指针越远越短，周围几格一起鼓起来");
assert.ok(tickWidth(200, 40) - TICK_WIDTH < 0.01, "离得够远就跟平时一样");
assert.equal(tickWidth(30, 40), tickWidth(50, 40), "上下对称");

// ── 读到哪一条 ──────────────────────────────────────────────────────────────
// 视口高 600，阅读线在 200。
assert.equal(activeInput([0, 450, 900], 600, false), 0, "第二颗气泡还在阅读线下面：仍在读原始需求那一段");
assert.equal(activeInput([-800, 150, 700], 600, false), 1, "越过阅读线的最后一颗");
assert.equal(activeInput([-800, -300, 199], 600, false), 2);
assert.equal(activeInput([-800, null, 300], 600, false), 0, "找不到气泡的那一条不参与");
assert.equal(activeInput([-1600, -400, 450], 600, true), 2, "贴着底：视口里露出来的最后一条就是在读的");
assert.equal(activeInput([-1600, -400, 650], 600, true), 1, "贴着底也得真露出来才算");

// ── Q 交给谁 ───────────────────────────────────────────────────────────────
const toggled: string[] = [];
assert.equal(toggleConversationInputs(), false, "一条导航都没有：放过这颗键");
let pageVisible = true;
const unregisterPage = registerConversationInputsTarget({ available: () => pageVisible, toggle: () => toggled.push("page") });
let drawerVisible = true;
const unregisterDrawer = registerConversationInputsTarget({ available: () => drawerVisible, toggle: () => toggled.push("drawer") });
assert.equal(toggleConversationInputs(), true);
assert.deepEqual(toggled, ["drawer"], "后挂上的（抽屉里那条会话）优先");
drawerVisible = false;
assert.equal(toggleConversationInputs(), true);
assert.deepEqual(toggled, ["drawer", "page"], "看不见的不认，往下找");
pageVisible = false;
assert.equal(toggleConversationInputs(), false, "都看不见：放过这颗键");
pageVisible = true;
unregisterDrawer();
unregisterDrawer();
assert.equal(toggleConversationInputs(), true);
assert.deepEqual(toggled, ["drawer", "page", "page"], "重复注销不会把别人摘掉");
unregisterPage();
assert.equal(toggleConversationInputs(), false);

console.log("conversation inputs tests passed");
