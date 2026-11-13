// 「后续追问」判据的回归测试（纯函数，不碰 DB 也不摸盘）：
//   isUserFollowUp —— 哪几种话算「我自己发的」，哪几种是机器代发/代写的
//   parseSessionOutput —— 落盘的 by:"system" 标记要能原样解回来
//   latestFollowUp —— 一个任务的多条会话里，哪一句才是「最后一条追问」
// 这条判据同时喂着两个界面（详情页 Inspector 的「后续追问」、侧边栏铺开后那一列），
// 而它判错了界面上看不出来 —— 只会显示成「我说过的一句话」，所以在这里钉住。
// 跑:npm -w server run test:follow-up
import assert from "node:assert/strict";
import { isUserFollowUp } from "@ash/shared";
import { parseSessionOutput } from "@ash/shared/session-output";
import { latestFollowUp, orderFollowUps, readLeavesComplete } from "../src/task-follow-up-pick.ts";

// ── 算我发的 ────────────────────────────────────────────────────────────────

assert.equal(isUserFollowUp({ kind: "user", text: "再发一下刚才那条" }), true, "真人打的字");
assert.equal(
  isUserFollowUp({ kind: "user", text: "验收通过：这条线上没有「合并并清理」这一站…\n\n你直接做合并并清理" }),
  true,
  "引用后端原话再补一句，整体仍是我发的（开头不在化石名单里就不该误杀）",
);

// ── 不算 ────────────────────────────────────────────────────────────────────

assert.equal(isUserFollowUp({ kind: "agent", text: "我已经改好了，要不要继续？" }), false, "agent 说的");
assert.equal(isUserFollowUp({ kind: "system", text: "继续（从中断处）" }), false, "系统代发的续跑提示");
assert.equal(
  isUserFollowUp({ kind: "user", text: "【自动验证未通过 · 第 1 轮】\n请按报告修复", bySystem: true }),
  false,
  "后端代写、占着真人回合的（新会话靠 by 标记认）",
);
assert.equal(
  isUserFollowUp({ kind: "user", text: "【自动审查未通过 · 第 1 轮】\n请按报告修复" }),
  false,
  "老会话没有 by 标记，靠化石前缀认（「自动审查」是老措辞）",
);
assert.equal(isUserFollowUp({ kind: "user", text: "【答复】你之前的提问:「放哪」\n\n放这儿" }), false, "答 agent 的问不算主动追问");
assert.equal(isUserFollowUp({ kind: "user", text: "   \n " }), false, "空白不算一条");
assert.equal(isUserFollowUp({ kind: "user" }), false, "没有正文不算一条");

// ── 落盘 → 解回来 ───────────────────────────────────────────────────────────

const turn = (t: string, text: string, extra: Record<string, unknown> = {}) =>
  `\x1e${JSON.stringify({ t, agent: "claude", text, at: "2026-08-06T01:00:00.000Z", ...extra })}`;
const segs = parseSessionOutput([
  "agent 的一段回复",
  turn("user", "我的追问"),
  "agent 又说了点什么",
  turn("user", "【自动验证未通过 · 第 2 轮】", { by: "system" }),
  turn("system", "继续（从中断处）"),
].join("\n"));

const mine = segs.filter(isUserFollowUp);
assert.equal(mine.length, 1, "四段里只有一段是我发的");
assert.equal(mine[0]?.text, "我的追问");
assert.equal(
  segs.find((seg) => seg.text.startsWith("【自动验证未通过"))?.kind,
  "user",
  "代写消息仍是 user 回合（followUpFrom 要靠它护住终态），只是多带一位标记",
);

// ── 多条会话里挑最后一句 ────────────────────────────────────────────────────
// order = 会话按开始时间倒序的位置（0 = 最近开始的那条）。

// 真实现场（2026-11-03）：执行会话开得最早、一路续跑，后面跟着四条审查会话。最后一句
// 在执行会话里，它排在最后也得挑中它 —— 不能因为它「开得早」就被审查会话挤出去。
assert.equal(
  latestFollowUp([
    { seg: { text: "审查里插的一句", at: "2026-11-03T04:10:00.000Z" }, order: 1 },
    { seg: { text: "执行会话里最新的追问", at: "2026-11-03T08:50:00.000Z" }, order: 4 },
  ])?.text,
  "执行会话里最新的追问",
  "按发言时刻比，不按会话开始先后",
);
assert.equal(
  latestFollowUp([
    { seg: { text: "老会话没时刻", at: null }, order: 0 },
    { seg: { text: "有时刻的", at: "2026-01-01T00:00:00.000Z" }, order: 3 },
  ])?.text,
  "有时刻的",
  "没时刻的老发言一律算旧",
);
assert.equal(
  latestFollowUp([
    { seg: { text: "更早开始的老会话", at: null }, order: 2 },
    { seg: { text: "较晚开始的老会话", at: null }, order: 1 },
  ])?.text,
  "较晚开始的老会话",
  "都没时刻时按会话开始先后兜底",
);
assert.equal(latestFollowUp([]), null, "一句都没有就是没有");

// ── 全部追问排成一条线 ──────────────────────────────────────────────────────
// 悬停铺开那一格时列全部追问：从旧到新，而且最后一条必须就是 latestFollowUp 挑中的那句 ——
// 外面那一格显示的和卡片里列在最新位置的不能是两句话。

const all = [
  { seg: { text: "执行会话里第一句", at: "2026-11-03T01:00:00.000Z" }, order: 4, index: 0 },
  { seg: { text: "执行会话里最新的追问", at: "2026-11-03T08:50:00.000Z" }, order: 4, index: 1 },
  { seg: { text: "审查里插的一句", at: "2026-11-03T04:10:00.000Z" }, order: 1, index: 0 },
  { seg: { text: "较晚开始的老会话", at: null }, order: 2, index: 0 },
  { seg: { text: "更早开始的老会话", at: null }, order: 3, index: 0 },
  { seg: { text: "同一刻的后一句", at: "2026-11-03T01:00:00.000Z" }, order: 4, index: 2 },
];
assert.deepEqual(
  orderFollowUps(all).map((seg) => seg.text),
  ["更早开始的老会话", "较晚开始的老会话", "执行会话里第一句", "同一刻的后一句", "审查里插的一句", "执行会话里最新的追问"],
  "按发言时刻从旧到新；没时刻的排最前、彼此按会话开始先后；同一刻保留正文顺序",
);
assert.equal(
  orderFollowUps(all).at(-1)?.text,
  latestFollowUp(all)?.text,
  "列表最新那条就是外面那一格显示的那句",
);
assert.deepEqual(orderFollowUps([]), [], "一句都没有就是空列表");

// ── 读没读全 ────────────────────────────────────────────────────────────────
// 「全部追问」要报总数，少读一条会话就少算几句：读不动的会话不能被当成「里面没说过话」。

assert.equal(readLeavesComplete({ ok: true }, true), true, "读到了就是读到了");
assert.equal(readLeavesComplete({ ok: false, missing: true }, false), true, "还在跑的会话可以还没建文件");
assert.equal(readLeavesComplete({ ok: false, missing: true }, true), false, "收了口还找不到文件 = 丢了一截");
assert.equal(readLeavesComplete({ ok: false, missing: false }, false), false, "文件在却读不动（权限 / I/O）");

console.log("✓ follow-up predicate");
