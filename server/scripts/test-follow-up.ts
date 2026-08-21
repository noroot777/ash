// 「后续追问」判据的回归测试（纯函数，不碰 DB 也不摸盘）：
//   isUserFollowUp —— 哪几种话算「我自己发的」，哪几种是机器代发/代写的
//   parseSessionOutput —— 落盘的 by:"system" 标记要能原样解回来
// 这条判据同时喂着两个界面（详情页 Inspector 的「后续追问」、侧边栏铺开后那一列），
// 而它判错了界面上看不出来 —— 只会显示成「我说过的一句话」，所以在这里钉住。
// 跑:npm -w server run test:follow-up
import assert from "node:assert/strict";
import { isUserFollowUp, parseSessionOutput } from "@ash/shared";

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

console.log("✓ follow-up predicate");
