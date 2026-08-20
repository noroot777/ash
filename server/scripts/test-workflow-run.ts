// 工作流接管审查链的回归：一条线上写的「自动验证 / 没过怎么办 / 等我点头」到底有没有
// 真的管住派审。全是纯判定，所以这个文件不起 CLI、不建任务。
// Run: npm -w server run test:workflow-run
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harness-workflow-run-"));
process.env.HARNESS_DB = join(root, "harness.db");
process.env.HARNESS_RUNS_DIR = join(root, "runs");

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
// 「验完要不要停下等人」**不是**能从整条线一次算出来的属性(那正是 2026-08-05 那次
// 关口被跳过的错误模型),它由推进器按游标逐站走出来 —— 所以这里只钉「线上画没画这
// 一站」,走到那儿停不停由下面的 nextAnchor 与 test-workflow-gate 钉。
const hasGate = (def: { steps: { kind: string }[] }) => def.steps.some((s) => s.kind === "human");
assert.equal(hasGate(standard), true, "标准交付画了「等我点头」");
assert.equal(std.autoAccept, true, "标准交付点头之后要合并");

const quick = workflowPolicy(fast)!;
assert.equal(quick.verify, null, "极速原型不验");
assert.equal(hasGate(fast), false, "极速原型干完就算完");
assert.equal(quick.autoAccept, false, "极速原型不合并");

// 一条 干活 → 等我点头 的线:没有验证站,但照样得停下等人
const gateOnly = { workspace: "isolated" as const, steps: [makeStep("run", "s1"), makeStep("human", "s2")] };
const gate = workflowPolicy(gateOnly)!;
assert.equal(gate.verify, null, "这条线不自动验");
assert.equal(hasGate(gateOnly), true, "但它写着等我点头");

// 没过就停下等人:轮数退化成 1,不存在第二轮
const stopLine = structuredClone(standard);
const stopVerify = stopLine.steps.find((s) => s.kind === "verify")!;
stopVerify.fail = { mode: "stop", max: 3 };
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

// ── 一条线上写好几站「自动验证」「等我点头」 ──────────────────────────────
// 段落按**站的 id** 切,不按锚点类型——这正是这两类站能出现多次的前提。以前按类型切
// 的时候,第二个 verify 没有任何东西能把它跟第一个区分开,只会被静默跳过。
const { segmentAfter, nextAnchor, prevAnchor, isFinalHumanGate, anchorAt } =
  await import("@harness/shared/workflow-policy");
const multi = {
  workspace: "isolated" as const,
  steps: [
    makeStep("run", "m1"), makeStep("command", "m2"),
    makeStep("verify", "m3"), makeStep("preview", "m4"),
    makeStep("human", "m5"), makeStep("command", "m6"),
    makeStep("verify", "m7"),
    makeStep("human", "m8"), makeStep("accept", "m9"),
  ],
};
assert.deepEqual(
  segmentAfter(multi, "m3").map((s) => s.id), ["m4"],
  "第一站验完之后跑 m4:段落认的是这一站的 id,不是「线上第一个 verify」",
);
assert.deepEqual(
  segmentAfter(multi, "m7").map((s) => s.id), [],
  "第二站验完之后紧接着就是第二道关口,中间没有站",
);
assert.deepEqual(
  segmentAfter(multi, "m5").map((s) => s.id), ["m6"],
  "第一道关口放行之后那一段——不是「点头就合并」,后面还画着东西呢",
);
assert.equal(nextAnchor(multi, "m1")?.id, "m3", "干完之后下一个停下来等的点是第一站验证");
assert.equal(nextAnchor(multi, "m3")?.id, "m5", "第一站验完之后是第一道关口");
assert.equal(nextAnchor(multi, "m5")?.id, "m7", "第一道关口放行之后是第二站验证");
assert.equal(nextAnchor(multi, "m8"), null, "最后一道关口之后再没有会停的站了,这条线走到头");
assert.equal(prevAnchor(multi, "m7")?.id, "m5", "第二站没过要退回的是它前面那个锚点");
assert.equal(prevAnchor(multi, "m3")?.id, "m1", "第一站没过就退回干活站,那正是老行为");
assert.equal(prevAnchor(multi, "m1"), null, "干活站前面没有锚点了");
assert.equal(
  isFinalHumanGate(multi, "m5"), false,
  "中途关口:这一按是「放行」,绝不能顺手把不可逆的合并做掉",
);
assert.equal(isFinalHumanGate(multi, "m8"), true, "最后一道关口才是「这份产物我认了,去合吧」");
assert.equal(isFinalHumanGate(multi, null), true, "游标丢了当最后一道处理——那正是只有一道关口的老行为");
assert.equal(isFinalHumanGate(multi, "m3"), true, "游标压根不在关口上(比如停在验证站)时不改变老语义");

// **只有一道关口，但画在验证前面**——用户最常画的那种线（干活 → 预览 → 等我点头 →
// 验证 → 合并）。旧判据只数「后面还有没有别的『等我点头』」，这条线一道都没有，于是
// 它被判成最终关口:点验收直接合并 + 删 worktree + 删分支,用户亲手画在中间的「自动
// 验证」被整站跳过(2026-08-05 事故第二段,见 docs/incidents.md)。判据必须是「后面还
// 有没有**任何**会停下来的站」,新判据是旧判据的超集,上面 multi 那几条一字未改。
const gateFirst = {
  workspace: "isolated" as const,
  steps: [
    makeStep("run", "g1"), makeStep("preview", "g2"), makeStep("human", "g3"),
    makeStep("verify", "g4"), makeStep("accept", "g5"),
  ],
};
assert.equal(
  isFinalHumanGate(gateFirst, "g3"), false,
  "关口后面还画着「自动验证」,这一按就只能是放行——一道关口不等于最后一道关口",
);
assert.equal(nextAnchor(gateFirst, "g3")?.id, "g4", "放行之后该去的正是那一站验证");
assert.equal(anchorAt(multi, "m7", "verify")?.id, "m7", "游标指着第二站,读的就是第二站的参数");
assert.equal(anchorAt(multi, null, "verify")?.id, "m3", "游标为空回落到线上第一站,老任务行为不变");
assert.equal(anchorAt(multi, "m5", "verify")?.id, "m3", "游标指的不是这一类锚点时同样回落");
// 每一站可以各写各的失败策略,读的是**游标那一站**的
const perStation = structuredClone(multi);
(perStation.steps.find((s) => s.id === "m3") as { fail: unknown }).fail = { mode: "back", max: 3 };
(perStation.steps.find((s) => s.id === "m7") as { fail: unknown }).fail = { mode: "stop", max: 3 };
assert.equal(workflowPolicy(perStation, "m3")!.verifyRounds, 3, "第一站写了最多 3 轮");
assert.equal(workflowPolicy(perStation, "m7")!.onVerifyFail, "stop", "第二站写的是没过就停下等人");
assert.equal(
  nextAnchor(perStation, "m7")?.kind, "human",
  "第二站后面还有一道关口:验完照样停下等人",
);
// 自带起手式也走同一条判据:验证站之后的下一个会停的点就是那道关口。**读的是站的
// 前后关系,不是「线上有没有 human」**——用户可以把关口画在验证前面(见
// test-workflow-gate),那时验证站后面就没有关口了,推进器该往下走而不是回头找人。
assert.equal(
  nextAnchor(standard, standard.steps.find((s) => s.kind === "verify")!.id)?.kind, "human",
  "标准交付验完的下一个停靠点是「等我点头」",
);

// ── 打回重做之后该重验哪一站 ──────────────────────────────────────────────
const { settleFrom } = await import("../src/workflow-advance.js");
assert.equal(
  settleFrom(multi, "m7"), "m5",
  "第二站没过、重做完再结算:退回它前面那个锚点,那一段重跑一遍再**重新验这一站**",
);
assert.equal(settleFrom(multi, "m3"), "m1", "第一站没过就退回干活站");
assert.equal(settleFrom(multi, null), "m1", "游标丢了从干活站起,老行为");
assert.equal(settleFrom(multi, "m5"), "m1", "游标不在验证站上(正常干完一轮)就是从干活站起");
assert.equal(settleFrom(null, "m7"), null, "身上没有线的老任务不进推进器");

// ── 每一站的验证轮数各数各的 ──────────────────────────────────────────────
const { verifyStationAction } = await import("../src/review-policy.js");
const station = {
  parentIsTeam: false, reviewRequested: false, mode: "single",
  workflow: perStation, at: "m3", stage: null as string | null, rounds: 0,
};
assert.equal(verifyStationAction(station), "dispatch", "这一站还没验过:派审");
assert.equal(
  verifyStationAction({ ...station, rounds: 1, stage: "verify_failed" }), "dispatch",
  "这一站没过一轮、线上写着最多 3 轮:再验一轮",
);
assert.equal(
  verifyStationAction({ ...station, rounds: 3, stage: "verify_failed" }), "halt",
  "轮数用尽是**停下**不是跳过——绝不绕过用户亲手画的验证站",
);
assert.equal(
  verifyStationAction({ ...station, at: "m7", rounds: 1, stage: "verify_failed" }), "halt",
  "第二站写的是「没过就停下等人」:第一轮没过就停",
);
assert.equal(
  verifyStationAction({ ...station, rounds: 1, stage: null }), "skip",
  "这一站已经验过又没判失败:算过了,往下走",
);
assert.equal(
  verifyStationAction({ ...station, mode: "team" }), "skip",
  "团队调度台不进推进器",
);
assert.equal(
  verifyStationAction({ ...station, parentIsTeam: true, reviewRequested: false }), "skip",
  "团队执行者没要求审查:不能因为默认起手式带了验证站就凭空冒出审查任务",
);

// ── 验收通过那一刻按线上写的做 ────────────────────────────────────────────
const { acceptPlan, hasAcceptStation } = await import("@harness/shared/workflow-policy");
assert.deepEqual(
  acceptPlan(null), { merge: "safe", clean: "all" },
  "老任务身上没有线：验收还是老规矩(安全合并 + worktree 和分支都删)，行为分毫不变",
);
assert.deepEqual(
  acceptPlan(standard), { merge: "safe", clean: "all" },
  "标准交付那一站写的就是安全合并 + 全清",
);
// 线上没画「合并并清理」时，做什么取决于谁按的——这两条是同一条线、同一份配置，
// 只因按下的人不同而分岔，所以必须成对钉住，改一条就会露出另一条。
assert.deepEqual(
  acceptPlan(fast, "workflow"), { merge: null, clean: "none" },
  "线自己走到验收、线上又没画这一站：git 一动不动（没画的事不自动发生）",
);
assert.deepEqual(
  acceptPlan(fast, "human"), { merge: "safe", clean: "all" },
  "同一条线上人亲手点验收：照老规矩合并并清理——手按覆盖线上写没写",
);
assert.deepEqual(
  acceptPlan(fast), { merge: "safe", clean: "all" },
  "缺省就是人按的：绝大多数调用方是用户点的按钮，自动路径必须显式说自己是 workflow",
);
// 中途关口按下的「验收通过」= 放行,不是「去合吧」。这条是红线:线上还画着别的站,
// 顺手把不可逆的合并做掉,是拿用户没表达过的意思替他做主。
assert.deepEqual(
  acceptPlan(multi, "human", "m5"), { merge: null, clean: "none" },
  "中途关口:人亲手点也不合并、不清理——这一按只放行这一关",
);
assert.deepEqual(
  acceptPlan(multi, "human", "m8"), { merge: "safe", clean: "all" },
  "最后一道关口:照线上那一站写的合并并清理",
);
assert.deepEqual(
  acceptPlan(multi, "human"), { merge: "safe", clean: "all" },
  "不传游标就是老行为(只有一道关口),分毫不变",
);
assert.deepEqual(
  acceptPlan(gateFirst, "human", "g3"), { merge: null, clean: "none" },
  "关口画在验证前面:那一按是放行,git 一动都不许动(不然后面那站验证连工作区都没了)",
);
assert.equal(hasAcceptStation(fast), false, "快速通道线上确实没画这一站");
assert.equal(hasAcceptStation(standard), true, "标准交付画了");
assert.equal(hasAcceptStation(null), false, "身上没有线的老任务也算没画（文案照实说）");
// 线上**画了**这一站时，两条路完全一致——覆盖只发生在「线上没写」的空白处，
// 不是「人按下就无视线上参数」。用户特意选了 squash，手动验收也得是 squash。
const squashLine = structuredClone(standard);
const squashStep = squashLine.steps.find((s) => s.kind === "accept")!;
if (squashStep.kind === "accept") squashStep.p = { strategy: "squash", clean: "worktree" };
assert.deepEqual(
  acceptPlan(squashLine), { merge: "squash", clean: "worktree" },
  "改了那一站的参数，验收就按改后的做——线上画着什么，按下去就发生什么",
);
assert.deepEqual(
  acceptPlan(squashLine, "workflow"), acceptPlan(squashLine, "human"),
  "线上画了这一站：谁按的都按它写的做，人按不会把 squash 改回 safe",
);

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
  mode: "single", status: "done", stage: null, reviewRequested: false,
  labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "claude",
  autoTitle: false, useWorktree: false, createdAt: at, updatedAt: at,
});
const task = (await db.select().from(tasks)).find((row) => row.id === "t1")!;

const okStep = makeStep("command", "c1");
if (okStep.kind === "command") okStep.p = { cmd: "touch ran.txt", where: "workspace" };
const okLine = { workspace: "shared" as const, steps: [makeStep("run", "r"), okStep] };
assert.deepEqual(
  await runSegment(task, okLine, "r"), { ok: true },
  "命令站跑通了这一段就算过",
);
assert.ok(existsSync(join(repo, "ran.txt")), "命令真的在任务工作目录里跑过");

const badStep = makeStep("command", "c2");
if (badStep.kind === "command") badStep.p = { cmd: "echo 这条过不了 >&2; exit 3", where: "repo" };
const badLine = { workspace: "shared" as const, steps: [makeStep("run", "r"), badStep, okStep] };
rmSync(join(repo, "ran.txt"), { force: true }); // 先擦掉上一段的产物，下面那句断言才算数
const bad = await runSegment(task, badLine, "r");
assert.equal(bad.ok, false, "命令没跑过,这一段就卡在这儿");
assert.equal(bad.failed?.id, "c2", "卡在哪一站要报得出来——调用方靠它读失败策略");
assert.match(bad.reason ?? "", /这条过不了/, "把命令自己的话原样带出来,别只说一句失败");
assert.ok(
  !existsSync(join(repo, "ran.txt")),
  "前一站砸了就不再往下跑：后面的站多半依赖前面的产物",
);

// ── 「合并并清理」这一站真按下去 ──────────────────────────────────────────
// t1 没开独立 worktree，所以验收落在「就地认可」那一档：git 不动，stage 变 accepted。
// 这里要钉住的是**谁按的**——线上没写「等我点头」，就该由这条线自己按。
const acceptLine = { workspace: "shared" as const, steps: [makeStep("run", "r"), makeStep("accept", "ac")] };
assert.deepEqual(
  await runSegment(task, acceptLine, "r"), { ok: true },
  "干完之后紧接着就是「合并并清理」：不等人，自己按",
);
const afterAccept = (await db.select().from(tasks)).find((row) => row.id === "t1")!;
assert.equal(afterAccept.stage, "accepted", "按下去之后阶段真的走到 accepted");

const { eq } = await import("drizzle-orm");
await db.update(tasks).set({ stage: null }).where(eq(tasks.id, "t1")); // 擦掉上面那次的痕迹
assert.deepEqual(
  await runSegment(task, acceptLine, "r", { skipAccept: true }), { ok: true },
  "用户刚点完验收时回头跑这一段，得跳过这一站——那正是刚做完的事",
);
assert.equal(
  (await db.select().from(tasks)).find((row) => row.id === "t1")!.stage, null,
  "跳过就是真没按：阶段一动不动，不会验收第二遍",
);

// ── 预览站真起真收 ────────────────────────────────────────────────────────
const { startPreview, readPreview, stopPreview } = await import("../src/preview.js");
const port = 14000 + (process.pid % 900);
const previewStep = makeStep("preview", "pv");
if (previewStep.kind === "preview") {
  previewStep.p = {
    cmd: `node -e "if(process.env.HARNESS_PREVIEW!=='1'||process.env.HARNESS_PREVIEW_MODE!=='test')process.exit(12);require('http').createServer((q,s)=>s.end('ok')).listen(${port},()=>console.log('ready on http://localhost:${port}/'))"`,
    mode: "test",
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
  const replacement = makeStep("preview", "pv-replacement");
  if (replacement.kind === "preview") {
    replacement.p = {
      cmd: `node -e "if(process.env.HARNESS_PREVIEW_MODE!=='full')process.exit(13);require('http').createServer((q,s)=>s.end('next')).listen(${port + 1},()=>console.log('ready on http://localhost:${port + 1}/'))"`,
      mode: "full",
      ready: "http200",
      life: "gate",
    };
  }
  const replaced = await startPreview("t2", replacement as never, repo);
  assert.equal(replaced.ok, true, "另一个任务的预览也能起来");
  assert.ok(readPreview("t1"), "不同 worktree/任务的预览可以并行，旧预览仍在");
  assert.ok(readPreview("t2"), "新预览有自己的记录");
  assert.equal(await fetch(`http://localhost:${port + 1}/`).then((res) => res.text()), "next");
  assert.equal(await stopPreview("t2", "测试收尾"), true);
  assert.equal(readPreview("t2"), null, "收掉之后记录一并删掉");
  const unsafe = makeStep("preview", "pv-unsafe");
  if (unsafe.kind === "preview") {
    unsafe.p = {
      cmd: `node -e "console.log('[harness] scheduler started');require('http').createServer((q,s)=>s.end('bad')).listen(${port + 3},()=>console.log('ready on http://localhost:${port + 3}/'))"`,
      mode: "command",
      ready: "http200",
      life: "gate",
    };
  }
  const refused = await startPreview("t3", unsafe as never, repo);
  assert.equal(refused.ok, false, "旧分支预览一旦启动真调度器必须当场拒绝");
  if (!refused.ok) assert.match(refused.reason, /真调度器/);
  assert.equal(await stopPreview("t1", "测试收尾"), true);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    await fetch(`http://localhost:${port}/`).then(() => true).catch(() => false),
    false,
    "进程真被杀了,不是只删了记录",
  );
}

// ── 一站没过之后,线上写的那一档真的做出来了 ────────────────────────────────
// 这是 codex 审出来的那条:三档失败策略以前只画在线路图上,按下去什么都不发生。
// 判据统一是「刷新后仍看得出来」——所以每一档都断言它留下的**持久痕迹**:时间线里
// 那一行、或者挂在任务上的那条提问。
const { applyFailPolicy, applyRunFailPolicy } = await import("../src/workflow-steps.js");
const { RUNS_DIR } = await import("../src/paths.js");
const { sessions } = await import("../src/db/schema.js");
await db.insert(sessions).values({
  id: "sess1", taskId: "t1", role: "single", agentType: "claude",
  executor: "claude", startedAt: at,
});
const timeline = () => {
  try {
    return readFileSync(join(RUNS_DIR, "t1", "sess1.md"), "utf8");
  } catch {
    return "";
  }
};
const questionOf = async () =>
  (await db.select().from(tasks)).find((row) => row.id === "t1")!.question;
const clearQuestion = () => db.update(tasks).set({ question: null, questionOptions: null }).where(eq(tasks.id, "t1"));

const stopStep = makeStep("command", "f-stop");
stopStep.fail = { mode: "stop", max: 2 };
await applyFailPolicy(task, stopStep, "构建挂了", () => "不该被用到");
assert.match(timeline(), /卡在「跑一条命令」这一站，停下等你处理/, "停下等人这一档:时间线上留得下痕迹");
assert.equal(await questionOf(), null, "停下等人不挂提问——它就是「什么都别问,我自己来」");

const askStep = makeStep("command", "f-ask");
askStep.fail = { mode: "ask", max: 2 };
await applyFailPolicy(task, askStep, "端口被占了", () => "不该被用到");
const asked = (await db.select().from(tasks)).find((row) => row.id === "t1")!;
assert.match(asked.question ?? "", /接下来怎么办/, "问我一句这一档:真的把问题挂到任务上");
assert.match(asked.question ?? "", /端口被占了/, "——并且把报错原文带上,不然没法答");
assert.equal(JSON.parse(asked.questionOptions ?? "[]").length, 3, "给三条能直接当答复读的建议");
await clearQuestion();

// 打回重做数着轮数:落盘的计数已经到上限时就停下,不无限打回
const backStep = makeStep("verify", "f-back");
backStep.fail = { mode: "back", max: 2 };
mkdirSync(join(RUNS_DIR, "t1"), { recursive: true });
writeFileSync(join(RUNS_DIR, "t1", "workflow-steps.json"), JSON.stringify({ "f-back": 2 }));
await applyFailPolicy(task, backStep, "还是没过", () => "不该被用到");
assert.match(timeline(), /已经打回重做 2 次仍没过/, "到了线上写的上限就停,不再叫醒 agent");
assert.equal(await questionOf(), null, "到上限是停下等人,不是改成提问");

// 「让 AI 干活」这一站自己没干成,读的是那一站自己的失败分支
await applyRunFailPolicy(task, null);
assert.equal(await questionOf(), null, "老任务身上没有线:一切照旧,不凭空冒出提问");
const runStop = { workspace: "shared" as const, steps: [makeStep("run", "r")] };
await applyRunFailPolicy(task, runStop);
assert.equal(await questionOf(), null, "干活站写的是「停下等人」:什么都不做");
const runAsk = structuredClone(runStop);
runAsk.steps[0]!.fail = { mode: "ask", max: 2 };
await applyRunFailPolicy(task, runAsk);
assert.match((await questionOf()) ?? "", /让 AI 干活/, "干活站写的是「问我一句」:这一轮没干成就真的问");
await clearQuestion();

// ── 「任务结束时回收」得真有个结束点 ──────────────────────────────────────
const taskLife = makeStep("preview", "pv2");
if (taskLife.kind === "preview") {
  taskLife.p = {
    cmd: `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(${port + 2},()=>console.log('ready on http://localhost:${port + 2}/'))"`,
    mode: "command",
    ready: "http200",
    life: "task",
  };
}
const { stopPreviewAtAccept } = await import("../src/preview.js");
const lifeStarted = await startPreview("t1", taskLife as never, repo);
assert.equal(lifeStarted.ok, true, `「任务结束时回收」那一档也得起得来（${lifeStarted.ok ? "" : lifeStarted.reason}）`);
await stopPreviewAtAccept("t1");
assert.equal(readPreview("t1"), null, "验收走完就是这个任务的终点,选了「任务结束时回收」就真的在这儿收掉");
await new Promise((r) => setTimeout(r, 300));
assert.equal(
  await fetch(`http://localhost:${port + 2}/`).then(() => true).catch(() => false),
  false,
  "端口真让出来了,不是只删了记录",
);

rmSync(join(RUNS_DIR, "t1"), { recursive: true, force: true });
rmSync(root, { recursive: true, force: true });
console.log("workflow step runner tests passed");
