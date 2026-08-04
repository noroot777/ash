// 工作流接管审查链的回归：一条线上写的「自动验证 / 没过怎么办 / 等我点头」到底有没有
// 真的管住派审。全是纯判定，所以这个文件不起 CLI、不建任务。
// Run: npm -w server run test:workflow-run
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
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

// ── 段落切分：哪几站跟在哪个锚点后面 ──────────────────────────────────────
const { stepsAfterAnchor } = await import("@harness/shared/workflow-policy");
const line = {
  workspace: "isolated" as const,
  steps: [
    makeStep("run", "s1"), makeStep("command", "s2"),
    makeStep("verify", "s3"), makeStep("preview", "s4"), makeStep("command", "s5"),
    makeStep("human", "s6"), makeStep("accept", "s7"),
  ],
};
assert.deepEqual(
  stepsAfterAnchor(line, "run").map((s) => s.id), ["s2"],
  "干完之后那一段：到「自动验证」为止",
);
assert.deepEqual(
  stepsAfterAnchor(line, "verify").map((s) => s.id), ["s4", "s5"],
  "验完之后那一段：到「等我点头」为止,预览就在这儿起",
);
assert.deepEqual(
  stepsAfterAnchor(line, "human").map((s) => s.id), ["s7"],
  "点头之后那一段",
);
assert.deepEqual(
  stepsAfterAnchor(standard, "human").map((s) => s.kind), ["accept"],
  "标准交付点头之后就是合并并清理",
);
assert.deepEqual(stepsAfterAnchor(fast, "verify"), [], "线上没这个锚点就是空段");
assert.deepEqual(stepsAfterAnchor(null, "run"), []);

// ── 命令站真跑 ────────────────────────────────────────────────────────────
const { execFileSync } = await import("node:child_process");
const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "-b", "main", repo]);
writeFileSync(join(repo, "seed.txt"), "seed\n");

const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks } = await import("../src/db/schema.js");
const { runSegment } = await import("../src/workflow-steps.js");
await ensureSchema();
const at = new Date("2026-01-01T00:00:00Z").toISOString();
await db.insert(projects).values({ id: "p1", name: "wf", repoPath: repo, createdAt: at });
await db.insert(tasks).values({
  id: "t1", projectId: "p1", groupId: null, parentId: null, title: "t", body: "",
  mode: "single", status: "done", stage: null, reviewRequested: false, priority: "none",
  labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "claude",
  autoTitle: false, useWorktree: false, createdAt: at, updatedAt: at,
});
const task = (await db.select().from(tasks)).find((row) => row.id === "t1")!;

const okStep = makeStep("command", "c1");
if (okStep.kind === "command") okStep.p = { cmd: "touch ran.txt", where: "workspace" };
const okLine = { workspace: "shared" as const, steps: [makeStep("run", "r"), okStep] };
assert.deepEqual(
  await runSegment(task, okLine, "run"), { ok: true },
  "命令站跑通了这一段就算过",
);
assert.ok(existsSync(join(repo, "ran.txt")), "命令真的在任务工作目录里跑过");

const badStep = makeStep("command", "c2");
if (badStep.kind === "command") badStep.p = { cmd: "echo 这条过不了 >&2; exit 3", where: "repo" };
const badLine = { workspace: "shared" as const, steps: [makeStep("run", "r"), badStep, okStep] };
rmSync(join(repo, "ran.txt"), { force: true }); // 先擦掉上一段的产物，下面那句断言才算数
const bad = await runSegment(task, badLine, "run");
assert.equal(bad.ok, false, "命令没跑过,这一段就卡在这儿");
assert.equal(bad.failed?.id, "c2", "卡在哪一站要报得出来——调用方靠它读失败策略");
assert.match(bad.reason ?? "", /这条过不了/, "把命令自己的话原样带出来,别只说一句失败");
assert.ok(
  !existsSync(join(repo, "ran.txt")),
  "前一站砸了就不再往下跑：后面的站多半依赖前面的产物",
);

// ── 预览站真起真收 ────────────────────────────────────────────────────────
const { startPreview, readPreview, stopPreview } = await import("../src/preview.js");
const port = 14000 + (process.pid % 900);
const previewStep = makeStep("preview", "pv");
if (previewStep.kind === "preview") {
  previewStep.p = {
    cmd: `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(${port},()=>console.log('ready on http://localhost:${port}/'))"`,
    ready: "http200",
    life: "gate",
  };
}
const started = await startPreview("t1", previewStep as never, repo);
assert.equal(started.ok, true, `预览应该起得来（${started.ok ? "" : started.reason}）`);
if (started.ok) {
  assert.equal(started.record.port, port, "端口从日志里那行地址读出来");
  assert.equal((await fetch(started.record.url!)).status, 200, "起来之后真能访问");
  assert.ok(readPreview("t1"), "pid 落盘了,server 重启后照样收得掉");
  assert.equal(await stopPreview("t1", "测试收尾"), true);
  assert.equal(readPreview("t1"), null, "收掉之后记录一并删掉");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    await fetch(`http://localhost:${port}/`).then(() => true).catch(() => false),
    false,
    "进程真被杀了,不是只删了记录",
  );
}

rmSync(root, { recursive: true, force: true });
console.log("workflow step runner tests passed");
