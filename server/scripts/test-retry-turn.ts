// 「重跑上一回合」认输入的判据（纯函数，不碰 DB 也不摸盘）。
// 认错了界面上看不出来：会静默退回「从中断处续跑」，而崩在 CLI 起来之前的那一回合根本
// 没把指令交给 CLI —— 用户点了重试，agent 却什么都没收到。所以在这里钉住。
// 跑:npm -w server run test:retry-turn
import assert from "node:assert/strict";
import { lastInputOf } from "../src/task-retry-turn.js";

const turn = (t: string, text: string, extra: Record<string, unknown> = {}) =>
  `\x1e${JSON.stringify({ t, agent: "claude", text, at: "2026-08-13T01:00:00.000Z", ...extra })}`;

// ── 续聊回合崩了：最后一段是我打的字 → 原样重投 ────────────────────────────
{
  const seg = lastInputOf([
    turn("user", "第一句"),
    "agent 干完了第一件事",
    turn("user", "把标题也改一下"),
    "agent 刚开口就崩了",
    "> 续聊回合异常结束(退出码 1),任务状态保持「已完成」不变。",
  ].join("\n"));
  assert.equal(seg?.kind, "user", "最后一段是真人回合");
  assert.equal(seg?.text, "把标题也改一下", "取的是最后那句，不是第一句");
  assert.equal(seg?.kind === "user" ? seg.bySystem : undefined, undefined, "真人发的不带代写标记");
}

// ── 自由工作流自动修复回合崩了：最后一段是后端代写的 user 回合 → 重投并保留标记 ──
{
  const seg = lastInputOf([
    turn("user", "【自由工作流审查未通过 · 第 1 轮】\n请按报告修复", { by: "system" }),
    "agent 起来就吃了 503",
  ].join("\n"));
  assert.equal(seg?.kind, "user", "代写消息仍占真人回合");
  assert.equal(seg?.kind === "user" ? seg.bySystem : undefined, true, "重投时要原样带回 by:system，别把机器的话记成用户说的");
}

// ── 上一回合本来就是系统续跑 → 不重投，退回 resume ──────────────────────────
{
  const seg = lastInputOf([
    turn("user", "开工"),
    "agent 干了一半",
    turn("system", "继续（从中断处）"),
    "agent 又崩了",
  ].join("\n"));
  assert.equal(seg?.kind, "system", "最后一段是系统提示，重投它没有意义");
}

// ── 首跑（会话里一个非 agent 段都没有）→ 退回 resume ────────────────────────
assert.equal(lastInputOf("agent 从头到尾自己说话"), null, "没有输入段就没有可重投的东西");
assert.equal(lastInputOf(""), null, "空正文");

console.log("✓ retry-turn input predicate");
