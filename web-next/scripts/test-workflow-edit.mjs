// 编排时的连带修复（web-next/src/workflow/workflowEdit.ts）。
//
// 盯住一件事：**任何一次改动之后，这条线仍然能存进去**。加站要挡住重复的锚点、id
// 不能撞车、挪站不能误伤别站的失败策略；如果修复漏在某条路径上，用户的表现是「改了
// 一下，就说这条线存不了，还不知道为什么」。
//
// 跑法：npm -w web-next run test:workflow-edit
import assert from "node:assert/strict";
import { MAX_WORKFLOW_STEPS, isWorkflowUsable, makeStep } from "@harness/shared/workflow";
import {
  canAddKind, canAddStep, failText, insertStep, moveStep, nextStepId, patchFail, patchParams, removeStep,
} from "../src/workflow/workflowEdit.ts";

const line = (...kinds) => ({
  workspace: "isolated",
  steps: kinds.map((kind, i) => makeStep(kind, `s${i + 1}`)),
});
const kinds = (def) => def.steps.map((s) => s.kind);
const ids = (def) => def.steps.map((s) => s.id);

// ── 加站 ──────────────────────────────────────────────────────────────────
const base = line("run", "human", "accept");
assert.deepEqual(kinds(insertStep(base, 1, "verify")), ["run", "verify", "human", "accept"]);
assert.deepEqual(kinds(insertStep(base, 0, "command")), ["command", "run", "human", "accept"]);
assert.deepEqual(kinds(insertStep(base, 99, "command")), ["run", "human", "accept", "command"], "越界就插末尾");
assert.equal(new Set(ids(insertStep(base, 1, "verify"))).size, 4, "新站的 id 不能撞车");

// 会停下来等的那几站每种只能有一个：菜单据此置灰，插进去也得原样退回
assert.equal(canAddKind(base, "human"), false, "已经有「等我点头」了");
assert.equal(canAddKind(base, "verify"), true);
assert.equal(insertStep(base, 1, "accept"), base, "重复的锚点不能悄悄插进去");

// 删掉中间那站再加，id 要能补空位而不是一路涨
const gap = removeStep(line("run", "verify", "human"), "s2");
assert.equal(nextStepId(gap), "s2");
assert.ok(!ids(insertStep(gap, 1, "verify")).some((id, i, all) => all.indexOf(id) !== i), "补空位也不能撞车");

let full = line("run");
while (canAddStep(full)) full = insertStep(full, 99, "command");
assert.equal(full.steps.length, MAX_WORKFLOW_STEPS);
assert.equal(insertStep(full, 0, "command"), full, "到上限就原样返回，不悄悄丢一站");

// ── 删站 / 挪站 ───────────────────────────────────────────────────────────
// 「回到第几站」这个旋钮已经删了（back 一律把报错交回给干活的 agent，见 shared/
// workflow.ts 的注释），所以删站、挪站不再需要修回拐 —— 但仍得保证：改完还是一条
// 能存进去的线，且别站的设置不被误伤。
let def = line("run", "verify", "human");
def = patchFail(def, "s2", { mode: "back", max: 3 });
assert.equal(def.steps[1].fail.mode, "back");
const dropped = removeStep(def, "s3");
assert.deepEqual(kinds(dropped), ["run", "verify"]);
assert.equal(dropped.steps[1].fail.mode, "back", "删掉不相干的一站，别人的失败策略不该被动");
assert.ok(isWorkflowUsable(dropped), "删完还得是一条能存的线");

let moved = line("run", "verify", "human", "accept");
moved = patchFail(moved, "s2", { mode: "back", max: 2 });
const swapped = moveStep(moved, "s3", -1);
assert.deepEqual(kinds(swapped), ["run", "human", "verify", "accept"]);
assert.equal(swapped.steps[2].fail.max, 2, "挪个位置不该改掉这一站的轮数");
assert.ok(isWorkflowUsable(swapped));

// 挪不动的时候原样返回
assert.equal(moveStep(moved, "s1", -1), moved);
assert.equal(moveStep(moved, "s4", 1), moved);

// ── 失败策略 ──────────────────────────────────────────────────────────────
let f = line("run", "verify");
f = patchFail(f, "s2", { mode: "back", max: 9 });
assert.equal(f.steps[1].fail.max, 5, "轮数夹在 1..5");
f = patchFail(f, "s2", { mode: "back", max: 0 });
assert.equal(f.steps[1].fail.max, 1);
f = patchFail(f, "s1", { mode: "ask" });
assert.equal(f.steps[1].fail.mode, "back", "只改点名的那一站");

const texts = line("run", "verify");
assert.equal(failText(texts.steps[0]), "停下等人");
const asked = patchFail(texts, "s2", { mode: "ask" });
assert.equal(failText(asked.steps[1]), "问我一句再决定");
const backed = patchFail(texts, "s2", { mode: "back", max: 3 });
assert.equal(failText(backed.steps[1]), "打回给 AI 重做 · 最多 3 轮");
const noFail = line("preview");
assert.equal(failText(noFail.steps[0]), null, "预览没有失败分支");

// ── 改参数 ────────────────────────────────────────────────────────────────
const p = patchParams(line("run", "verify"), "s2", { checks: ["build", "tests"] });
assert.deepEqual(p.steps[1].p.checks, ["build", "tests"]);
assert.equal(p.steps[1].p.executorId, null, "只动传进来的那个字段");
assert.deepEqual(p.steps[0].p, line("run").steps[0].p, "别的站不该被碰");

console.log("✓ 编排改动与连带修复全部符合预期");
