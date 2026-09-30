// 「意见成立，但不属于本任务 → 转独立任务」这条出路的回归。
//
// 它和旁边那条驳回支线（test-free-review-dispute.ts）共用同一条停顿，所以这里只钉
// **新出路自己的**那几件事，不重复验驳回的门禁：
// ① 执行者只能**提出**——`dispute_review` 这一路一个任务都不许建（裁定权在用户手上）；
// ② 没有提出过就不能裁定 deferred（否则它变成谁都能按的免修按钮）；
// ③ 提出之后链停下来等人：自动复审预约撤掉、任务不被唤醒去修；
// ④ 裁定之后真的建出一个 **backlog、未起跑**、带着报告路径/证据目录/回链的任务，
//    而审查结论本身一个字不改；
// ⑤ 修复入口跟着关掉——那几条已经有别的任务在承接，在本任务里再修一遍就是两处各改一版。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-free-review-defer-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

let failure: unknown = null;
try {
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Ash Test");
  git(repo, "config", "user.email", "ash@example.test");
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
  const reviewedCommit = git(repo, "rev-parse", "HEAD");

  const { ensureSchema, db } = await import("../src/db/index.js");
  const {
    agents, freeReviewRounds, freeReviewRuns, freeWorkflowStates, projects, reviewerProfiles, tasks,
  } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { claimTurn, releaseTurn } = await import("../src/runs.js");
  const {
    disputeFreeReview, disputeInputOf, disputeResolutionOf, hasDispute, openDisputeOf,
    resolveFreeReviewDispute, waivedDisputeOf,
  } = await import("../src/free-review-dispute.js");
  const { deferOpenDispute } = await import("../src/free-review-defer.js");
  const { freeWorkflowState, startManualFreeReviewRepair } = await import("../src/free-workflow.js");
  const { freeReviewEvidenceDir, freeReviewReportPath } = await import("../src/free-review-files.js");
  const { freeManualRepairPrompt, freeRepairPrompt, freeReviewPrompt } = await import("../src/free-review-prompts.js");
  const { settledRulingsOf } = await import("../src/free-review-settled.js");

  await ensureSchema();
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "defer", repoPath: repo, createdAt: at });
  await db.insert(agents).values({ id: "ex", name: "codex@test", type: "codex", model: "gpt-test", isDefault: true });
  await db.insert(reviewerProfiles).values({
    id: "reviewer", name: "逻辑审查者", agentType: "codex", executorId: "ex", createdAt: at, updatedAt: at,
  });

  /** 造一个「最近一轮审查未通过、停在等处理」的自由任务。 */
  async function seed(id: string, opts: { reservation?: { runId: string | null } } = {}) {
    await createTasks([{
      id, projectId: "p", title: `原任务 ${id}`, body: "test", mode: "single", status: "done",
      agentType: "codex", executorId: "ex", autoTitle: false, workflowMode: "free",
      labels: JSON.stringify(["free"]), useWorktree: true, worktreeBase: "main",
      mergeTargetBranch: "main", createdAt: at, updatedAt: at,
    }]);
    const runId = `${id}-run`;
    await db.insert(freeReviewRuns).values({
      id: runId, taskId: id, reviewerId: "reviewer", reviewerName: "逻辑审查者", agentType: "codex",
      executorId: "ex", checkMode: "logic", retryLimit: 1, currentRound: 1,
      status: "stopped", createdAt: at, updatedAt: at, finishedAt: at,
    });
    const roundId = `${runId}-round`;
    await db.insert(freeReviewRounds).values({
      id: roundId, runId, round: 1, status: "failed", conclusion: "verify_failed",
      reviewedCommit, startedAt: at, endedAt: at,
    });
    if (opts.reservation) {
      await db.insert(freeWorkflowStates).values({
        taskId: id, selectedReviewerId: "reviewer", reviewArmed: true, reviewCheckMode: "logic",
        reviewRetryLimit: 1, reviewRunId: opts.reservation.runId, updatedAt: at,
      });
    }
    return { runId, roundId };
  }

  const roundRow = (roundId: string) => db.select().from(freeReviewRounds)
    .where(eq(freeReviewRounds.id, roundId)).then((rows) => rows[0]!);
  const taskCount = () => db.select().from(tasks).then((rows) => rows.length);
  const rejects = async (fn: () => Promise<unknown>, needle: string, message: string) => {
    await assert.rejects(fn, (error: Error) => {
      assert.ok(error.message.includes(needle), `${message}（实际：${error.message}）`);
      return true;
    }, message);
  };

  // ── ① 入参：两段理由至少有一段 ──
  assert.throws(() => disputeInputOf({}), /必须写明理由/, "两段都空的驳回必须被拒");
  assert.throws(() => disputeInputOf({ reason: "  ", deferReason: "\n" }), /必须写明理由/,
    "只有空白也算空");
  assert.deepEqual(
    disputeInputOf({ deferReason: "  第 2 条是上一轮修复引入的  " }),
    { reason: "", deferReason: "第 2 条是上一轮修复引入的" },
    "只提转出时不强求 reason——强求它就只能在「哪条不成立」那栏里编一句自己都不认的话",
  );
  assert.deepEqual(
    disputeInputOf({ reason: "第 1 条读错了行号", deferReason: "第 2 条越界" }),
    { reason: "第 1 条读错了行号", deferReason: "第 2 条越界" },
    "两段可以同时给：一次交接里表达「不成立」和「成立但越界」共存",
  );
  assert.equal(disputeResolutionOf("deferred"), "deferred", "deferred 是合法裁定");
  assert.throws(() => disputeResolutionOf("defer"), /只能是 upheld/, "拼错的裁定要被拒");
  assert.equal(hasDispute({ disputeReason: null, disputeDeferReason: "x" } as never), true,
    "只提转出也算这一轮挂着驳回（openDisputeOf / CAS 都按它判）");
  assert.equal(hasDispute({ disputeReason: null, disputeDeferReason: null } as never), false);

  // ── ② 提出：执行者只能提，一个任务都不许建 ──
  const plain = await seed("f-defer", { reservation: { runId: "f-defer-run" } });
  assert.equal(claimTurn("f-defer", "single"), true);
  const before = await taskCount();
  await disputeFreeReview("f-defer", "", "第 2、3 条成立，但都是第 1 轮按意见修复时引入的并发保护，超出原任务边界");
  assert.equal(await taskCount(), before,
    "裁定权只在用户手上：执行者提出转出时一个任务都不许建（规矩①）");
  const row = await roundRow(plain.roundId);
  assert.equal(row.disputeReason, null, "只提转出时「哪条不成立」那栏留空，不编话");
  assert.equal(row.disputeDeferReason?.startsWith("第 2、3 条成立"), true, "转出理由落库");
  assert.ok(row.disputeAt, "提出时刻要落库");
  assert.equal(row.disputeResolution, null, "刚提出时还没有裁定");
  assert.equal(row.disputeDeferredTaskId, null, "还没裁定就不该有派生任务");
  assert.ok(await openDisputeOf("f-defer"), "链停在「等你裁定」");

  // 自动复审预约撤掉 + 任务没被唤醒去修（规矩④：提出之后停下来等人）。
  assert.equal((await db.select().from(freeWorkflowStates)
    .where(eq(freeWorkflowStates.taskId, "f-defer"))).at(0)?.reviewArmed, false,
    "提出转出同样要撤掉自动续轮预约：没改代码的复审只会拿到同一份报告");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "f-defer"))).at(0)?.status, "done",
    "提出之后不自动修复：任务不许被唤醒");

  // CAS：两段理由一起判，「先只提转出、再只驳一条」也算重复。
  await rejects(() => disputeFreeReview("f-defer", "那我再驳一条"), "已经驳回过了",
    "一轮意见只能提一次（两列一起 CAS，不是各判各的）");
  releaseTurn("f-defer");

  // 审查旁路回合不能替执行者提出（同 dispute_review 的 turnRole 判据）。
  await seed("f-reviewer-turn");
  assert.equal(claimTurn("f-reviewer-turn", "reviewer"), true);
  await rejects(() => disputeFreeReview("f-reviewer-turn", "", "这条越界"),
    "审查回合不能驳回自己的结论", "审查旁路回合不能提出转独立任务");
  releaseTurn("f-reviewer-turn");

  // ── ③ 凭空的 deferred 裁定必须被拒（规矩③：不能变成免修按钮） ──
  const noOffer = await seed("f-no-offer");
  assert.equal(claimTurn("f-no-offer", "single"), true);
  await disputeFreeReview("f-no-offer", "这条读错了文件");
  releaseTurn("f-no-offer");
  await rejects(() => resolveFreeReviewDispute("f-no-offer", "deferred"),
    "执行者没有提出", "执行者没写越界依据时，用户也不能把意见转走");
  assert.equal((await roundRow(noOffer.roundId)).disputeResolution, null, "被拒的裁定不许落库");
  assert.equal(await taskCount(), before + 2, "被拒的裁定不许留下任务（只有两条原任务被 seed 出来）");

  // ── ④ 用户裁定 deferred：建出 backlog 派生任务，审查结论一个字不改 ──
  const resolved = await resolveFreeReviewDispute("f-defer", "deferred", "这几条连同上一轮那个 helper 一起重写，别只补空值检查。");
  assert.equal(resolved.resolution, "deferred");
  assert.equal(resolved.repairError, null, "转独立任务不发起修复");
  const derived = resolved.deferredTask!;
  assert.ok(derived, "裁定必须回报建出来的那个任务");
  assert.equal(derived.status, "backlog", "派生任务是待办：起不起、什么时候起由用户决定");
  assert.equal(derived.originTaskId, "f-defer", "回链到原任务");
  assert.equal(derived.parentId, null, "它是独立任务，不是谁的执行者");
  assert.equal(derived.workflowMode, "free");
  // 标题**先说是哪个任务，再说派生缘由**：缘由放前面时，列表里连着几条派生任务只剩同一
  // 串前缀，真正区分它们的那半截被挤到省略号之后（用户 2026-09-30 反馈）。
  assert.equal(derived.title, "原任务 f-defer · 承接第 1 轮审查的越界意见",
    "派生任务标题必须是「原任务名 · 缘由」，不是「缘由：原任务名」");
  assert.equal(derived.agentType, "codex", "执行器配置继承原任务");
  assert.equal(derived.mergeTargetBranch, "main", "最终合入目标继承原任务，与开工起点各算各的");
  assert.equal(derived.worktreeBase, reviewedCommit,
    "开工起点冻结在被审查的那一版 commit 上：分支会随验收消失，从别处开工连复现都做不到");
  assert.ok(derived.body.includes(freeReviewReportPath("f-defer", plain.runId, 1)), "body 里要带审查报告路径");
  assert.ok(derived.body.includes(freeReviewEvidenceDir("f-defer", plain.runId, 1)), "body 里要带证据目录");
  assert.ok(derived.body.includes("第 2、3 条成立"), "body 里要带执行者逐条给出的越界依据");
  assert.ok(derived.body.includes("f-defer"), "body 里要指明原任务");
  // 裁定要点必须跟着搬进新任务：它是**用户**写的话（多半是「转走，但按这个方案做」），
  // 留在原任务上的话，真正干这几条活的人一个字都看不到。
  assert.ok(derived.body.includes("这几条连同上一轮那个 helper 一起重写，别只补空值检查。"),
    "用户裁定转出时写的要点要写进派生任务的 body");

  const deferredRow = await roundRow(plain.roundId);
  assert.equal(deferredRow.disputeResolution, "deferred", "裁定落库");
  assert.equal(deferredRow.disputeResolutionNote,
    "这几条连同上一轮那个 helper 一起重写，别只补空值检查。", "裁定要点也落在这一轮上");
  assert.equal(deferredRow.disputeDeferredTaskId, derived.id, "派生任务 id 记在这一轮上（幂等靠它）");
  assert.equal(deferredRow.conclusion, "verify_failed", "转走不改写审查结论");
  assert.equal((await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, plain.runId))).at(0)?.status,
    "stopped", "转走 ≠ 这一轮 passed（规矩②）");
  assert.equal(await openDisputeOf("f-defer"), null, "裁定之后不再是「待裁定」");
  await rejects(() => resolveFreeReviewDispute("f-defer", "upheld"), "没有等待裁定的驳回", "裁过的不能再裁");

  // 状态快照要把两段理由和派生任务都带出去（界面上那张卡全靠它）。
  const state = await freeWorkflowState("f-defer");
  const snapshot = state.reviews.find((run) => run.id === plain.runId)?.rounds.at(0)?.dispute;
  assert.equal(snapshot?.reason, "", "只提转出时快照里的驳回理由是空串");
  assert.ok(snapshot?.deferReason?.includes("超出原任务边界"), "快照必须带上转出理由");
  assert.equal(snapshot?.resolution, "deferred");
  assert.equal(snapshot?.deferredTaskId, derived.id, "快照必须带上派生任务 id");

  // ── ⑤ 裁定之后修复入口关掉（前端藏按钮，后端照样挡） ──
  const waived = await waivedDisputeOf("f-defer");
  assert.equal(waived?.round.id, plain.roundId, "waivedDisputeOf 认得 deferred 这一档");
  await rejects(() => startManualFreeReviewRepair("f-defer"), "已被你裁定转为独立任务",
    "转走的那几条不能在本任务里再修一遍（否则两处各改一版）");

  // ── ⑥ 幂等：重复裁定回到同一个任务，不建第二个 ──
  const runRow = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, plain.runId))).at(0)!;
  const sourceRow = (await db.select().from(tasks).where(eq(tasks.id, "f-defer"))).at(0)!;
  const countBeforeRetry = await taskCount();
  const again = await deferOpenDispute(sourceRow, { run: runRow, round: await roundRow(plain.roundId) });
  assert.equal(again.id, derived.id, "重复裁定回到同一个派生任务");
  assert.equal(await taskCount(), countBeforeRetry, "重复裁定不许建第二个任务");

  // ── ⑦ 混合形态：reason 与 deferReason 同时给，两段都落库、两个出口都在 ──
  const mixed = await seed("f-mixed");
  assert.equal(claimTurn("f-mixed", "single"), true);
  await disputeFreeReview("f-mixed", "第 1 条读错了行号：foo.ts:12 那一行是生成代码",
    "第 4 条成立，但它是第 2 轮修复引入的，建议单独做");
  releaseTurn("f-mixed");
  const mixedRow = await roundRow(mixed.roundId);
  assert.equal(mixedRow.disputeReason, "第 1 条读错了行号：foo.ts:12 那一行是生成代码");
  assert.equal(mixedRow.disputeDeferReason, "第 4 条成立，但它是第 2 轮修复引入的，建议单独做");
  // 同一条驳回上，用户仍然可以选「采纳执行者」而不是转出——两条出路并存，不是二选一。
  const withdrawn = await resolveFreeReviewDispute("f-mixed", "withdrawn");
  assert.equal(withdrawn.resolution, "withdrawn");
  assert.equal(withdrawn.deferredTask, null, "采纳执行者不建任务");
  assert.equal((await roundRow(mixed.roundId)).disputeDeferredTaskId, null,
    "没选转出就不该留下派生任务");
  await rejects(() => startManualFreeReviewRepair("f-mixed"), "已被你裁定作废",
    "withdrawn 的措辞一个字不变（现有两条出路语义不许动）");

  // ── ⑧ 裁定过的那几条自动讲给下一轮，两侧都讲 ──
  // 不做这一步的话，用户每次派审都得手打一句「有异议的已经转为新任务，只审查本次改动
  // 内容」——一条系统自己就记着的事实，靠人每轮复述（用户 2026-09-30 反馈）。
  const nextRun: Parameters<typeof freeReviewPrompt>[1] = {
    id: "f-defer-run-2", taskId: "f-defer", reviewerId: "reviewer", reviewerName: "逻辑审查者",
    agentType: "codex", executorId: "ex", model: null, reasoningEffort: null, checkMode: "logic",
    note: null, retryLimit: 1, targetKind: "workspace", targetBranch: null, targetBaseCommit: null,
    targetCommit: null, repairTaskId: null, currentRound: 1, status: "reviewing",
    createdAt: at, updatedAt: at, finishedAt: null,
  };
  const nextPrompt = await freeReviewPrompt(sourceRow, nextRun, 1, repo);
  assert.match(nextPrompt, /已由用户裁定、不在本任务里修的意见/, "下一轮审查提示必须带上已裁定的那几条");
  assert.ok(nextPrompt.includes(derived.id), "要指名承接它们的那个独立任务，否则审查者无从核对");
  assert.ok(nextPrompt.includes("第 2、3 条成立"), "执行者当时逐条写的越界依据要带过去（哪几条靠它认）");
  assert.ok(nextPrompt.includes("这几条连同上一轮那个 helper 一起重写"), "用户裁定时写的要点也要带过去");
  assert.match(nextPrompt, /本轮\*\*不要再报\*\*/, "审查者那一侧的落点是「不要再报」");
  assert.match(nextPrompt, /新出现\*\*的问题不受此限/, "但不能把审查者的嘴封死：同一处的新问题照常报");

  const nextRepair = await freeRepairPrompt("f-defer", nextRun);
  assert.match(nextRepair, /已由用户裁定、不在本任务里修的意见/, "执行者那一侧也要知道，否则它会照新报告再改一遍");
  assert.match(nextRepair, /不要在这里改，调用 dispute_review/, "执行者那一侧的落点是「走转出这个出口」而不是照改");
  assert.ok(nextRepair.includes("写进 deferReason"), "转出过的那几条要指明走 deferReason 这个出口");
  assert.ok(!nextRepair.includes("写进 reason"), "这个任务没裁定过作废，就别讲作废那一档怎么办");

  // 没有裁定过的任务不许凭空多出这一节（空清单必须什么都不加）。
  const cleanSource = (await db.select().from(tasks).where(eq(tasks.id, "f-no-offer"))).at(0)!;
  const cleanPrompt = await freeReviewPrompt(
    cleanSource, { ...nextRun, id: "f-no-offer-run-2", taskId: "f-no-offer" }, 1, repo);
  assert.doesNotMatch(cleanPrompt, /已由用户裁定/, "没裁定过的任务不该凭空多出这一节");

  // ── ⑨ 裁定攒多了也一条都不许丢（第 1 轮审查复现的那条） ──
  // 曾按条数只留最近 4 条，于是第 5 次裁定之后最早那次转出的意见在三条交接里全部消失，
  // 界面却仍按全部条数承诺「会自动讲给审查者」——用户又得手写那句话。现在清单不截断，
  // 只在正文超预算时省掉**正文**，并明说去哪读。
  const bulk = "越界依据正文".repeat(400); // 远超单段上限，用来把正文预算撑爆
  for (let n = 1; n <= 8; n += 1) {
    const stamp = `2027-01-0${n}T00:00:00.000Z`;
    await db.insert(freeReviewRuns).values({
      id: `f-defer-hist-${n}`, taskId: "f-defer", reviewerId: "reviewer", reviewerName: "逻辑审查者",
      agentType: "codex", executorId: "ex", checkMode: "logic", retryLimit: 1, currentRound: 1,
      status: "stopped", createdAt: stamp, updatedAt: stamp, finishedAt: stamp,
    });
    await db.insert(freeReviewRounds).values({
      id: `f-defer-hist-${n}-round`, runId: `f-defer-hist-${n}`, round: 1, status: "failed",
      conclusion: "verify_failed", reviewedCommit, disputeDeferReason: `第 ${n} 次转出：${bulk}`,
      disputeResolution: "deferred", disputeResolvedAt: stamp, disputeDeferredTaskId: `f-defer-derived-${n}`,
      startedAt: stamp, endedAt: stamp,
    });
  }
  const many = await settledRulingsOf("f-defer", { runId: "f-defer-run-3", round: 1 });
  assert.equal(many.length, 9, "9 次裁定就得回 9 条：界面按全部条数承诺会自动讲，服务端不能偷偷少讲几条");
  const manyPrompt = await freeReviewPrompt(sourceRow, { ...nextRun, id: "f-defer-run-3" }, 1, repo);
  for (let n = 1; n <= 8; n += 1) {
    assert.ok(manyPrompt.includes(`f-defer-derived-${n}`), `第 ${n} 次转出的承接任务不许从提示里消失`);
  }
  assert.ok(manyPrompt.includes(derived.id), "最早那次转出的承接任务同样不许消失");
  // 正文超预算时省的是**正文**，且必须说出来并给去处，否则读者会以为这几条本来就没写依据。
  assert.match(manyPrompt, /逐条依据没有内联/, "正文带不下时要明说，不能悄悄少一段");
  assert.ok(manyPrompt.includes(freeReviewReportPath("f-defer", "f-defer-hist-1", 1)),
    "被省掉正文的那条也要留下报告路径，读者才有地方去看");
  const manyRepair = await freeRepairPrompt("f-defer", { ...nextRun, id: "f-defer-run-3" });
  const manyManual = await freeManualRepairPrompt("f-defer", { ...nextRun, id: "f-defer-run-3" });
  for (const prompt of [manyRepair, manyManual]) {
    assert.ok(prompt.includes("f-defer-derived-1") && prompt.includes("f-defer-derived-8"),
      "执行者那两条交接同样一条都不许丢");
  }

  console.log("free review defer ok");
} catch (error) {
  failure = error;
} finally {
  releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
