// 线路图的两条产品承诺（web-next/src/workflow/workflowModel.ts）。
//
// ① **站底下那行字 = 任务列表里那一格的字**。线路图说走到这步会显示「待验收」，
//    用户就会在列表里按这三个字找它；差一个字，这条线在他眼里就是错的。
// ② **游标读的是真实状态**，不是假进度条：换句话说，线路图上亮着的那一站，必须能
//    从任务此刻的 status/stage 反推出来，反过来也对得上 STEP_RUNTIME。
//
// 跑法：npm -w web-next run test:workflow-rail
//
// 注意这里**不 import @harness/shared/workflow-presets**：它对 "./workflow.js" 是运行时
// import，而 node --experimental-strip-types 不把 .js 说明符映射回 .ts（同 AGENTS.md 里
// 那条 shared 铁律，server 侧用 tsx 所以碰不到）。线在这儿自己拼，反正 presets 的内容
// 由 server 的 test:workflow 管。
import assert from "node:assert/strict";
import { STAGE_LABELS, TASK_STATUS_LABELS } from "@harness/shared";
import { STEP_KINDS, STEP_RUNTIME, makeStep } from "@harness/shared/workflow";
import { railStops, resolveCursor, stepStatusLabel, workflowSummary } from "../src/workflow/workflowModel.ts";

const line = (...kinds) => ({
  workspace: "isolated",
  steps: kinds.map((kind, i) => makeStep(kind, `s${i + 1}`)),
});

// ── ① 文案不能有第二份真相 ──────────────────────────────────────────────────
for (const kind of STEP_KINDS) {
  const { status, stage } = STEP_RUNTIME[kind];
  const expected = stage ? STAGE_LABELS[stage] : TASK_STATUS_LABELS[status];
  assert.equal(stepStatusLabel(kind), expected, `${kind} 的展示文案跟列表对不上`);
}
// 这几条是用户真正会照着找的，写死一遍防止哪天 STAGE_LABELS 被改了没人发现
assert.equal(stepStatusLabel("run"), "运行中");
assert.equal(stepStatusLabel("verify"), "验证中");
assert.equal(stepStatusLabel("human"), "待验收");
assert.equal(stepStatusLabel("accept"), "验收完成");

// ── ② 游标：标准交付这条线（干活 → 验证 → 等我点头 → 合并）─────────────────
const std = line("run", "verify", "human", "accept");
assert.equal(workflowSummary(std), "干活 → 验证 → 等我点头 → 合并");

const at = (status, stage = null, question = null) =>
  resolveCursor(std.steps, { status, stage, question });

assert.deepEqual(at("backlog"), { index: -1, blocked: false }, "还没开工不该亮任何一站");
assert.deepEqual(at("queued"), { index: -1, blocked: false });
assert.deepEqual(at("running"), { index: 0, blocked: false }, "跑起来就停在「干活」");
assert.deepEqual(at("running", "verifying"), { index: 1, blocked: false });
assert.deepEqual(at("failed", "verify_failed"), { index: 1, blocked: true }, "验证没过是卡住不是往下走");
assert.deepEqual(at("done", "verified"), { index: 2, blocked: false }, "验证过了就该等人点头");
assert.deepEqual(at("awaiting_review", "awaiting_acceptance"), { index: 2, blocked: false });
assert.deepEqual(at("done", "accepted"), { index: 4, blocked: false }, "验收完 = 整条走完");

// 卡住的三种：失败、手停、跑到检查点 —— 都是「停在这一站」而不是「过了这一站」
for (const status of ["failed", "canceled", "paused"]) {
  assert.deepEqual(at(status), { index: 0, blocked: true }, `${status} 该标成卡住`);
}
// 等答复也算卡住：任务确实没在往下走
assert.deepEqual(at("running", null, "选哪个方案？"), { index: 0, blocked: true });
assert.deepEqual(at("running", "verifying", "要继续吗？"), { index: 1, blocked: true });

// ── 每一站的 done/current/pending 分布 ─────────────────────────────────────
const states = (task) => railStops(std, task).map((s) => s.state);
assert.deepEqual(states(null), ["pending", "pending", "pending", "pending"], "没任务时整条是灰的");
assert.deepEqual(states({ status: "backlog", stage: null, question: null }),
  ["pending", "pending", "pending", "pending"]);
assert.deepEqual(states({ status: "running", stage: null, question: null }),
  ["current", "pending", "pending", "pending"]);
assert.deepEqual(states({ status: "running", stage: "verifying", question: null }),
  ["done", "current", "pending", "pending"]);
assert.deepEqual(states({ status: "awaiting_review", stage: "awaiting_acceptance", question: null }),
  ["done", "done", "current", "pending"]);
assert.deepEqual(states({ status: "done", stage: "accepted", question: null }),
  ["done", "done", "done", "done"], "验收完整条都该是走过的");
assert.deepEqual(states({ status: "failed", stage: "verify_failed", question: null }),
  ["done", "blocked", "pending", "pending"]);

// ── 线里没有对应的站时不能瞎指 ─────────────────────────────────────────────
// 「极速原型」只有一站干活：任何 stage 都只能落在它身上或者「走完了」，不能落到 -1
// 以外的负数或中间不存在的位置。
const fast = line("run");
for (const stage of [null, "implemented", "verifying", "awaiting_acceptance", "verified"]) {
  const cursor = resolveCursor(fast.steps, { status: "running", stage, question: null });
  assert.ok(cursor.index >= 0 && cursor.index <= fast.steps.length,
    `stage=${stage} 在只有一站的线上算出了 ${cursor.index}`);
}
assert.deepEqual(resolveCursor(fast.steps, { status: "done", stage: "accepted", question: null }),
  { index: 1, blocked: false }, "没有合并站也该认得「已验收 = 走完了」");

// 空线不该炸
assert.deepEqual(resolveCursor([], { status: "running", stage: null, question: null }),
  { index: -1, blocked: false });

// 站的顺序被用户排乱了也不能越界
const weird = [makeStep("human", "h"), makeStep("run", "r")];
const cursor = resolveCursor(weird, { status: "awaiting_review", stage: "awaiting_acceptance", question: null });
assert.equal(cursor.index, 0, "human 排在前面时游标就该在前面");

console.log("✓ 线路图的状态口径与游标推断全部符合预期");
