// 线路图的两条产品承诺（web-next/src/workflow/workflowModel.ts）。
//
// ① **站底下那行字 = 任务列表里那一格的字**。线路图说走到这步会显示「待验收」，
//    用户就会在列表里按这三个字找它；差一个字，这条线在他眼里就是错的。
// ② **游标读的是真实状态**，不是假进度条：优先读任务身上那个真游标（workflowAt），
//    读不到才从 status/stage 反推——反推出来的位置也必须对得上 STEP_RUNTIME。
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
import { railStops, resolveCursor, stepStatusLabel, stepTitle, verifyStationAtCursor, workflowCost, workflowSummary } from "../src/workflow/workflowModel.ts";

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

// ── ③ 真游标压过反推 ──────────────────────────────────────────────────────
// 用户可以把「等我点头」画在「自动验证」**前面**（bq3PLDuZzZOt 那条线就是），这时
// stage 跟站不是一一对应的：任务停在关口上，stage 却可能是别处写的 verifying。反推
// 会指到后面那个 verify 站，把还没点过的关口画成「✓ 已过」——用户看到的是「我没点头
// 它却说我点了」。有真游标就必须读游标。
const gateFirst = {
  workspace: "isolated",
  steps: [makeStep("run", "s1"), makeStep("human", "s2"), makeStep("verify", "s3"), makeStep("accept", "s4")],
};
assert.deepEqual(
  resolveCursor(gateFirst.steps, { status: "done", stage: "verifying", question: null, workflowAt: "s2" }),
  { index: 1, blocked: false },
  "游标停在关口就是停在关口，stage 说什么都不算数",
);
assert.deepEqual(
  railStops(gateFirst, { status: "done", stage: "verifying", question: null, workflowAt: "s2" }).map((s) => s.state),
  ["done", "current", "pending", "pending"],
  "**没点头的关口绝不能画成已过**",
);
// 点过头之后游标才挪到验证站
assert.deepEqual(
  railStops(gateFirst, { status: "running", stage: "verifying", question: null, workflowAt: "s3" }).map((s) => s.state),
  ["done", "done", "current", "pending"],
);
// 停在这一站但没往下走的三种，游标路径也要标成卡住
assert.equal(resolveCursor(gateFirst.steps, { status: "failed", stage: null, question: null, workflowAt: "s1" }).blocked, true);
assert.equal(resolveCursor(gateFirst.steps, { status: "running", stage: null, question: "选哪个？", workflowAt: "s1" }).blocked, true);
assert.equal(resolveCursor(gateFirst.steps, { status: "done", stage: "verify_failed", question: null, workflowAt: "s3" }).blocked, true);
// 验收结论压过游标：合并/验收是终点，而游标多半还停在最后那道关口上
assert.deepEqual(
  resolveCursor(gateFirst.steps, { status: "done", stage: "accepted", question: null, workflowAt: "s2" }),
  { index: 4, blocked: false },
  "验收完 = 整条走完，别被停在半路的游标拽回去",
);
assert.deepEqual(
  resolveCursor(gateFirst.steps, { status: "done", stage: "merged", question: null, workflowAt: "s2" }),
  { index: 3, blocked: false },
);
// 游标指向线上没有的站（换过快照的老任务）→ 回落反推，不能算成 -1 或越界
assert.deepEqual(
  resolveCursor(std.steps, { status: "awaiting_review", stage: "awaiting_acceptance", question: null, workflowAt: "gone" }),
  { index: 2, blocked: false },
  "游标指到线外时按老办法反推",
);

// ── ④ 验证站上那两个按钮该不该出现 ────────────────────────────────────────
// 「再验一轮 / 人工强制通过」有两个表面（线路图、验证页），判据必须只有这一条，而且
// **只认真游标**：后端受理强制通过的条件就是「workflowAt 落在一个 verify 站上」，按
// stage 反推给按钮，用户按下去只会换回一句 409。
const stopped = (extra) => verifyStationAtCursor({ workflow: gateFirst, status: "done", stage: null, question: null, ...extra });
assert.deepEqual(stopped({ workflowAt: "s3", stage: "verify_failed" })?.stationId, "s3", "验证没过就该给出路");
assert.deepEqual(stopped({ workflowAt: "s3", stage: "verifying" })?.stationId, "s3",
  "**验证器压根没上报**时 stage 停在 verifying，那正是最需要按钮的一种，不许拿 stage 卡掉");
assert.equal(stopped({ workflowAt: "s2", stage: "verify_failed" }), null, "游标停在关口时不该冒出强制通过");
assert.equal(stopped({ workflowAt: "s1" }), null);
assert.equal(stopped({ workflowAt: "gone", stage: "verify_failed" }), null, "游标指到线外 = 后端也认不出这一站");
assert.equal(stopped({ workflowAt: null, stage: "verify_failed" }), null, "没有真游标就不给（反推出来的位置后端不认）");
assert.equal(stopped({ workflowAt: "s3", stage: "accepted" }), null, "已验收 = 这条线走完了，别再给放行键");
assert.equal(stopped({ workflowAt: "s3", stage: "merged" }), null);
assert.equal(verifyStationAtCursor({ workflow: null, status: "done", stage: "verify_failed", question: null, workflowAt: "s3" }),
  null, "没有编排的老任务不需要它：线上没有等着放行的合并");

// ── 摘要行那三个数 ────────────────────────────────────────────────────────
// 「顺利走完 N 步 · 要你出面 N 次 · 不顺利最多起 N 次 AI」 —— 它写在新建面板上，用户
// 会照着它判断这条线要花多少。所以三个数都必须从定义直接数出来，不许估。
const costed = line("run", "verify", "human", "accept");
costed.steps[1].fail = { mode: "back", max: 2 };
assert.deepEqual(workflowCost(costed), { steps: 4, gates: 1, aiRuns: 3 },
  "1 次干活 + 验证最多打回 2 轮 = 最多 3 次 AI");
assert.deepEqual(workflowCost(line("human")), { steps: 1, gates: 1, aiRuns: 0 },
  "线上没有干活站就一次 AI 都不起");
assert.deepEqual(workflowCost({ workspace: "isolated", steps: [] }), { steps: 0, gates: 0, aiRuns: 0 });

// ── 站台上的名字：能带参数就带 ────────────────────────────────────────────
const named = line("run", "command");
assert.equal(stepTitle(named.steps[0], () => null), "让 AI 干活", "查不到执行器就回落到通用说法");
assert.equal(stepTitle({ ...named.steps[0], p: { ...named.steps[0].p, executorId: "e1" } },
  (id) => (id === "e1" ? "codex@cpa" : null)), "让 codex@cpa 干活");
assert.equal(stepTitle(named.steps[1], () => null), "跑 npm run lint");
assert.equal(stepTitle({ ...named.steps[1], p: { ...named.steps[1].p, cmd: "  " } }, () => null),
  "跑一条命令", "命令被清空了就别硬编成「跑 」");

console.log("✓ 线路图的状态口径与游标推断全部符合预期");
