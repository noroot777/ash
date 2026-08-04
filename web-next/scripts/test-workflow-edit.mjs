// 编排时的连带修复（web-next/src/workflow/workflowEdit.ts）。
//
// 盯住一件事：**任何一次改动之后，这条线仍然能存进去**。删站、挪站会让「失败回拐」
// 悬空或变成往后跳，两者都会被 shared 的闸拒收；如果修复漏在某条路径上，用户的表现
// 是「改了一下，保存按钮就灰了，还不知道为什么」。
//
// 跑法：npm -w web-next run test:workflow-edit
import assert from "node:assert/strict";
import { MAX_WORKFLOW_STEPS, isWorkflowUsable, makeStep } from "@harness/shared/workflow";
import {
  backTargets, canAddStep, failText, insertStep, moveStep, nextStepId, patchFail, patchParams, removeStep,
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

// 删掉中间那站再加，id 要能补空位而不是一路涨
const gap = removeStep(line("run", "verify", "human"), "s2");
assert.equal(nextStepId(gap), "s2");
assert.ok(!ids(insertStep(gap, 1, "verify")).some((id, i, all) => all.indexOf(id) !== i), "补空位也不能撞车");

let full = line("run");
while (canAddStep(full)) full = insertStep(full, 99, "command");
assert.equal(full.steps.length, MAX_WORKFLOW_STEPS);
assert.equal(insertStep(full, 0, "command"), full, "到上限就原样返回，不悄悄丢一站");

// ── 删站：指向它的回拐必须一起清掉 ────────────────────────────────────────
let def = line("run", "verify", "human", "accept");
def = patchFail(def, "s3", { mode: "back", backTo: "s2", max: 3 });
assert.equal(def.steps[2].fail.mode, "back");
const dropped = removeStep(def, "s2");
assert.equal(dropped.steps[1].fail.mode, "stop", "回拐的目标没了就得降级");
assert.equal(dropped.steps[1].fail.backTo, null);
assert.ok(isWorkflowUsable(dropped), "删完还得是一条能存的线");

// ── 挪站：回拐变成往后跳也得降级 ──────────────────────────────────────────
let moved = line("run", "verify", "human", "accept");
moved = patchFail(moved, "s3", { mode: "back", backTo: "s2", max: 2 });
const swapped = moveStep(moved, "s3", -1); // human 挪到 verify 前面 → 回拐指向后面了
assert.deepEqual(kinds(swapped), ["run", "human", "verify", "accept"]);
assert.equal(swapped.steps[1].fail.mode, "stop", "往后跳的回拐必须降级");
assert.ok(isWorkflowUsable(swapped));

// 挪不动的时候原样返回
assert.equal(moveStep(moved, "s1", -1), moved);
assert.equal(moveStep(moved, "s4", 1), moved);

// 合法的回拐不该被误伤
let keep = line("run", "verify", "human", "accept");
keep = patchFail(keep, "s2", { mode: "back", backTo: "s1", max: 3 });
assert.equal(moveStep(keep, "s3", 1).steps[1].fail.backTo, "s1", "不相干的挪动别动人家的回拐");

// ── 失败策略 ──────────────────────────────────────────────────────────────
let f = line("run", "verify");
f = patchFail(f, "s2", { mode: "back", backTo: "s1", max: 9 });
assert.equal(f.steps[1].fail.max, 5, "轮数夹在 1..5");
f = patchFail(f, "s2", { mode: "stop" });
assert.equal(f.steps[1].fail.backTo, null, "不回拐了就不该留着旧目标");
f = patchFail(f, "s2", { mode: "back", backTo: "s1", max: 0 });
assert.equal(f.steps[1].fail.max, 1);

assert.deepEqual(backTargets(line("run", "verify", "human"), "s3").map((s) => s.id), ["s1", "s2"]);
assert.deepEqual(backTargets(line("run", "verify"), "s1"), [], "第一站没有可回的地方");

const texts = line("run", "verify");
assert.equal(failText(texts, texts.steps[0]), "停下等人");
const asked = patchFail(texts, "s2", { mode: "ask" });
assert.equal(failText(asked, asked.steps[1]), "问我一句再决定");
const backed = patchFail(texts, "s2", { mode: "back", backTo: "s1", max: 3 });
assert.equal(failText(backed, backed.steps[1]), "拐回第 1 站 · 最多 3 轮");
const noFail = line("preview");
assert.equal(failText(noFail, noFail.steps[0]), null, "预览没有失败分支");

// ── 改参数 ────────────────────────────────────────────────────────────────
const p = patchParams(line("run", "verify"), "s2", { checks: ["build", "tests"] });
assert.deepEqual(p.steps[1].p.checks, ["build", "tests"]);
assert.equal(p.steps[1].p.executorId, null, "只动传进来的那个字段");
assert.deepEqual(p.steps[0].p, line("run").steps[0].p, "别的站不该被碰");

console.log("✓ 编排改动与连带修复全部符合预期");
