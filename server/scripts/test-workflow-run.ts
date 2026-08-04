// 工作流接管审查链的回归：一条线上写的「自动验证 / 没过怎么办 / 等我点头」到底有没有
// 真的管住派审。全是纯判定，所以这个文件不起 CLI、不建任务。
// Run: npm -w server run test:workflow-run
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harness-workflow-run-"));
process.env.HARNESS_DB = join(root, "harness.db");

const { builtinWorkflowDef } = await import("@harness/shared/workflow-presets");
const { makeStep } = await import("@harness/shared/workflow");
const { workflowPolicy } = await import("@harness/shared/workflow-policy");
const { reviewOutcomeAction, shouldAutoDispatchReview, withVerifyExecutor } =
  await import("../src/review-policy.js");

const standard = builtinWorkflowDef("standard")!;
const fast = builtinWorkflowDef("fast")!;

// ── 策略层：从一条线读出执行链要的那几个答案 ──────────────────────────────
assert.equal(workflowPolicy(null), null, "身上没有线时策略也没有,调用方得自己走老路");

const std = workflowPolicy(standard)!;
assert.ok(std.verify, "标准交付带「自动验证」这一站");
assert.equal(std.verifyRounds, 2, "标准交付写的是没过拐回去,最多 2 轮");
assert.equal(std.onVerifyFail, "back", "标准交付没过是拐回第一站重做");
assert.equal(std.humanGate, true, "标准交付验完要等人点头");
assert.equal(std.autoAccept, true, "标准交付点头之后要合并");

const quick = workflowPolicy(fast)!;
assert.equal(quick.verify, null, "极速原型不验");
assert.equal(quick.humanGate, false, "极速原型干完就算完");
assert.equal(quick.autoAccept, false, "极速原型不合并");

// 一条 干活 → 等我点头 的线:没有验证站,但照样得停下等人
const gateOnly = { workspace: "isolated" as const, steps: [makeStep("run", "s1"), makeStep("human", "s2")] };
const gate = workflowPolicy(gateOnly)!;
assert.equal(gate.verify, null, "这条线不自动验");
assert.equal(gate.humanGate, true, "但它写着等我点头");

// 没过就停下等人:轮数退化成 1,不存在第二轮
const stopLine = structuredClone(standard);
const stopVerify = stopLine.steps.find((s) => s.kind === "verify")!;
stopVerify.fail = { mode: "stop", backTo: null, max: 3 };
const stopPolicy = workflowPolicy(stopLine)!;
assert.equal(stopPolicy.onVerifyFail, "stop");
assert.equal(stopPolicy.verifyRounds, 1, "不拐回去就只跑一轮,max 写多少都不算数");

// ── 该不该自动派审 ────────────────────────────────────────────────────────
const solo = {
  confirmedDone: true,
  status: "done" as const,
  parentIsTeam: false,
  mode: "single",
  reviewOf: null,
  reviewRequested: false,
  stage: null,
  existingRounds: 0,
};

assert.equal(
  shouldAutoDispatchReview({ ...solo, workflow: standard }),
  true,
  "单飞任务:线上有验证站就自动派审——这正是编排的意义",
);
assert.equal(
  shouldAutoDispatchReview({ ...solo, workflow: fast }),
  false,
  "线上没有验证站就不派",
);
assert.equal(
  shouldAutoDispatchReview(solo),
  false,
  "老任务(身上没有线)行为分毫不变:单飞任务从不自动派审",
);
assert.equal(
  shouldAutoDispatchReview({ ...solo, parentIsTeam: true, reviewRequested: false, workflow: standard }),
  false,
  "团队执行者:团队那边没要求审查时,不能因为默认起手式带了验证站就凭空冒出审查任务",
);
assert.equal(
  shouldAutoDispatchReview({ ...solo, parentIsTeam: true, reviewRequested: true, workflow: standard }),
  true,
  "团队执行者:团队要求了审查,照派",
);
assert.equal(
  shouldAutoDispatchReview({ ...solo, workflow: standard, stage: "verify_failed", existingRounds: 1 }),
  true,
  "第一轮没过,线上写着最多 2 轮,还能再验一轮",
);
assert.equal(
  shouldAutoDispatchReview({ ...solo, workflow: standard, stage: "verify_failed", existingRounds: 2 }),
  false,
  "跑满这条线写的轮数就停,不无限循环",
);
assert.equal(
  shouldAutoDispatchReview({ ...solo, workflow: stopLine, stage: "verify_failed", existingRounds: 1 }),
  false,
  "写着「没过就停下等人」的线,第一轮没过就停",
);

// ── 这一轮的结论怎么处置 ──────────────────────────────────────────────────
const verdict = { reviewStatus: "done" as const, conclusion: "verify_failed", reviewRequested: false };
assert.equal(
  reviewOutcomeAction({ ...verdict, round: 1, parentIsTeam: false, workflow: standard }),
  "repair",
  "第一轮没过:按线上写的拐回去重做",
);
assert.equal(
  reviewOutcomeAction({ ...verdict, round: 2, parentIsTeam: false, workflow: standard }),
  "stop",
  "第二轮仍没过:到了这条线写的上限,停下等人",
);
assert.equal(
  reviewOutcomeAction({ ...verdict, round: 1, parentIsTeam: false, workflow: stopLine }),
  "stop",
  "「没过就停下等人」的线,第一轮就停",
);
assert.equal(
  reviewOutcomeAction({ ...verdict, round: 1, parentIsTeam: true, reviewRequested: true }),
  "repair",
  "老任务原样:第一轮打回修复",
);

// ── 用哪个执行器去验 ──────────────────────────────────────────────────────
const picked = structuredClone(standard);
const pickedVerify = picked.steps.find((s) => s.kind === "verify")!;
if (pickedVerify.kind === "verify") {
  pickedVerify.p.executorId = "exec-codex";
  pickedVerify.p.model = "gpt-5.6";
  pickedVerify.p.reasoningEffort = "high";
}
const withLine = { workflow: JSON.stringify(picked) } as never;
assert.deepEqual(
  withVerifyExecutor(withLine, {}),
  { executorId: "exec-codex", model: "gpt-5.6", reasoningEffort: "high" },
  "「用哪个模型验」写在验证站上,派审时就得用它",
);
assert.deepEqual(
  withVerifyExecutor(withLine, { executorId: "exec-claude" }),
  { executorId: "exec-claude" },
  "用户手点「再审一轮」并指定了执行器时,以手点的为准",
);
assert.deepEqual(
  withVerifyExecutor({ workflow: null } as never, {}),
  {},
  "老任务没有线,派审照旧",
);
assert.deepEqual(
  withVerifyExecutor({ workflow: "{ 这不是 json" } as never, {}),
  {},
  "快照坏了就当没有线,绝不能因此把派审打挂",
);

console.log("workflow run policy tests passed");
