// `test-free-review-dispatch-retry.ts` 的台子:临时库、桩、种子数据、读写夹具。
//
// 为什么单独一个文件:用例自己已经十七条,而单文件七百行封顶(全局约定)。台子这一半跟「验
// 什么」无关 —— 它回答的是「怎么把一个重启后的现场摆出来」,拆开之后加用例不必再把它整份
// 读进上下文。
//
// **环境变量在模块体里就设好**(临时库路径、重试界、PATH 上的 codex 桩):下面每一个 `src/`
// 导入都是**动态**的,所以它们一定晚于这一段 —— 顺序反了就会连上用户的真实任务库。
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";

export const root = mkdtempSync(join(tmpdir(), "ash-review-dispatch-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
// 界压到 3:要测「连输到界」就得真的连输到界,默认 5 次每次都要驱动一轮释放点。
process.env.ASH_REVIEW_DISPATCH_ATTEMPTS = "3";
delete process.env.ASH_LAX_DONE;
// 桩放在 PATH 最前:ash MCP 预检会 spawn 这个名字去问登记,桩让它问不出结果而放行(理由
// 同文件头)。真执行器那一段由测试隔离闸拦着,不靠这个桩。
const stubBin = join(root, "bin");
mkdirSync(stubBin, { recursive: true });
writeFileSync(join(stubBin, "codex"), "#!/bin/sh\nexit 1\n");
chmodSync(join(stubBin, "codex"), 0o755);
process.env.PATH = `${stubBin}:${process.env.PATH ?? ""}`;

/** 摆好台子,把用例要用的东西一次交出去。 */
export async function startHarness() {
  const { ensureSchema, db } = await import("../src/db/index.js");
  const { agents, freeReviewRounds, freeReviewRuns, groups, projects, regressionEvidence,
    reviewerProfiles, sessions, tasks } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { handleFreeWorkflowSettlement, reserveFreeReview } = await import("../src/free-workflow.js");
  const { reconcileFreeReviews } = await import("../src/free-review-reconcile.js");
  const { claimReviewDispatch, dispatchReviewRound, preparingReviewDispatch,
    MAX_REVIEW_DISPATCH_ATTEMPTS, reviewDispatchArmed, reviewDispatchOwned, supersedeReviewDispatch } =
    await import("../src/free-review-dispatch.js");
  const { reviewLifecycle } = await import("../src/review-lifecycle-lock.js");
  const { completeRegressionSettlement, regressionSettlementConclusion } =
    await import("../src/regression-settlement.js");
  const { clearReviewDispatchIntent, releaseReviewDispatchClaim } =
    await import("../src/free-review-dispatch.js");
  const { failReviewStart, launchReviewRound, reopenFailedFreeReview,
    reviewOrphanStillUnowned } = await import("../src/free-review-round.js");
  const { redeliverReviewRound } = await import("../src/free-review-redeliver.js");
  const { claimOwnTurn, claimTurn, continueWhenIdle, releaseTurn, turnIdentity, whenTurnIdle } = await import("../src/runs.js");
  // 人工放开 / 幽灵锁巡检走的那条放锁路（用例⑥）。turn-lock.ts 直取：runs.js 不转出它。
  const { forceReleaseTurn } = await import("../src/turn-lock.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  const { freeReviewEvidenceDir } = await import("../src/free-review-files.js");
  const { evidenceState } = await import("../src/regression-evidence-lifecycle.js");
  await ensureSchema();

  assert.equal(MAX_REVIEW_DISPATCH_ATTEMPTS, 3, "界要能从环境读,否则这份用例测不动「连输到界」");

  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "review dispatch", repoPath: root, createdAt: at });
  await db.insert(groups).values({ id: "g", projectId: "p", name: "组", mode: "parallel", paused: false, createdAt: at });
  await db.insert(agents).values({ id: "ex", name: "test", type: "codex", model: "test", isDefault: true });
  await db.insert(reviewerProfiles).values({
    id: "reviewer", name: "reviewer", agentType: "codex", executorId: "ex", createdAt: at, updatedAt: at,
  });

  /**
   * 这个任务名下**全部**会话的时间线旁注,**按时刻排好序**。
   *
   * 两处都必须这样读:投递成功之后新写的几句落在新开的审查会话文件里,而「哪一句排在哪一句
   * 之前」正是用例③的判据 —— 按文件名拼接得到的是字典序,跟时间顺序没有关系。
   */
  const timeline = (taskId: string): string => {
    const dir = dirname(sessionTranscriptPath(taskId, "any"));
    const rows: Array<{ at: string; text: string }> = [];
    let files: string[];
    try { files = readdirSync(dir).filter((name) => name.endsWith(".md")); } catch { return ""; }
    for (const name of files) {
      for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
        // 旁注是一行 JSON（前面带一个 \x1E 回合分隔符）；执行器正文不是 JSON，跳过。
        const raw = line.startsWith("\x1e") ? line.slice(1) : line;
        if (!raw.startsWith("{")) continue;
        try {
          const row = JSON.parse(raw) as { text?: string; at?: string };
          if (row.text && row.at) rows.push({ at: row.at, text: row.text });
        } catch { /* 半截行 */ }
      }
    }
    return rows.sort((a, b) => a.at.localeCompare(b.at)).map((row) => row.text).join("\n");
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  const until = async (what: string, cond: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 500; i++) {
      if (await cond()) return;
      await settle();
    }
    assert.fail(`等不到：${what}`);
  };
  const runOf = async (taskId: string) =>
    (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.taskId, taskId))).at(0)!;
  const runRow = async (runId: string) =>
    (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, runId))).at(0)!;
  const roundOf = async (runId: string, round = 1) =>
    (await db.select().from(freeReviewRounds)
      .where(and(eq(freeReviewRounds.runId, runId), eq(freeReviewRounds.round, round)))).at(0)!;
  const reviewerSessions = async (taskId: string) =>
    (await db.select().from(sessions)
      .where(and(eq(sessions.taskId, taskId), eq(sessions.role, "reviewer")))).length;

  const freeTask = async (id: string) => {
    await createTasks([{
      id, projectId: "p", groupId: "g", title: id, body: "test", mode: "single", status: "running",
      agentType: "codex", executorId: "ex", autoTitle: false, workflowMode: "free",
      useWorktree: false, createdAt: at, updatedAt: at,
    }]);
    await db.insert(sessions).values({
      id: `${id}-session`, taskId: id, role: "single", agentType: "codex", executor: "test",
      cwd: root, startedAt: at, turnStartedAt: at,
    });
  };

  /**
   * 一条「刚跑完一个回合、挂着预约复审」的自由任务,回合锁还占在手上 —— 正是 IZk5 那一刻。
   *
   * 走 `handleFreeWorkflowSettlement` 而不是手写 run 行:要测的恰恰是**预约消费 → 建 run →
   * 投递**这整条交接,手写 run 会把前两段跳过去,而「预约已被消费」是原缺陷里最贵的那一半。
   */
  const armedTask = async (id: string) => {
    await freeTask(id);
    await reserveFreeReview(id, { reviewerId: "reviewer", checkMode: "logic", retryLimit: 1 });
    // run loop 在调结算钩子**之前**已经把终态写进库了（钩子跑在它的 try 里），派审的入口校验
    // 读的就是这一行；留着 running 会被「任务正在运行，结束后再派审」挡掉。
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, id));
    assert.equal(claimTurn(id, "single"), true, "结算钩子跑在回合锁里面");
  };

  /**
   * 释放点上**稳定赢**的竞争者:抢到锁之后**同步**把自己重排一次,所以下一个释放点上它仍是
   * 第一个 waiter。审查那一侧的重排要先 await 一次写时间线、一次写意图,必然排在它后面。
   *
   * 这是对现场的忠实复刻 —— 那次赢家就是同一个释放点上先注册的另一条排队续跑。
   */
  const camper = (taskId: string, times: number) => {
    const state = { held: null as ReturnType<typeof claimOwnTurn>, left: times };
    const camp = () => {
      state.held = claimOwnTurn(taskId, "single");
      assert.ok(state.held, "竞争者必须抢到锁，否则这份用例压根没复现竞态");
      if (--state.left > 0) whenTurnIdle(taskId, camp);
    };
    whenTurnIdle(taskId, camp);
    return state;
  };

  /**
   * 占住一条 run 的生命周期链,直到 `open()`。`job` 在放手那一刻才跑(用来代表「重跑换代次」)。
   *
   * 排在它后面的那一段(旧收尾)因此必须等 —— 这正是用例⑲要钉的东西。
   */
  const holdLifecycle = (runId: string, job: () => Promise<unknown> = async () => {}) => {
    let open = () => {};
    const gate = new Promise<void>((resolve) => { open = resolve; });
    return { open, done: reviewLifecycle(runId, () => gate.then(job)) };
  };

  const restarted = async (id: string, attempts: number, patch: Record<string, unknown> = {}) => {
    await freeTask(id);
    const runId = `${id}-run`;
    await db.insert(freeReviewRuns).values({
      id: runId, taskId: id, reviewerId: "reviewer", reviewerName: "reviewer", agentType: "codex",
      executorId: "ex", checkMode: "logic", retryLimit: 1, currentRound: 1, status: "reviewing",
      createdAt: at, updatedAt: at,
    });
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, id));
    // 这一行是 `launchReviewRound` 开头就落下的（`evidenceState`），所以重启后的现场一定有它。
    // 少了它,这一轮会先被「历史审查退役」判据捞走(没有锚定的 targetIdentity = 当成老链收尸),
    // 压根走不到派发补办那一步。它同时给出这一轮的**代次**,意图里记的就是它。
    const evidence = await evidenceState(id, freeReviewEvidenceDir(id, runId, 1),
      (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!);
    await db.insert(freeReviewRounds).values({
      id: `${runId}-round`, runId, round: 1, status: "reviewing", startedAt: at,
      dispatch: { attempts, since: at, resumeSessionId: null, generation: evidence.generation, ...patch },
    });
    assert.equal(reviewDispatchArmed(runId, 1), false, "重启后的内存里没有任何人盯着它");
    return runId;
  };

  /**
   * **拆台前的清场**(每份用例文件结束时调一次,传它用过的全部 task id)。
   *
   * 两件事都不是摆设:
   *  · **等回合退干净** —— 几条用例会真起一个回合(投递成功那一刻),它的收尾还要再写几次库。
   *    不等的话临时库在它们写到一半时就关了,日志里会多出几条「database is not open」:那是
   *    拆台的噪声,不是产品问题,但它会把真问题埋掉。
   *  · **扫认领表** —— 一张没有活负责人的认领证就等于「这一轮永远在途」:对账见它就跳过,库里
   *    那份没消费的意图再也没人补办(free-review-dispatch.ts 文件头 ⑩)。归还的出路有七八条
   *    (投递成功、放弃、让出、准备阶段抛、回调里抛…),逐条写断言钉不住「以后新加的那一条」,
   *    这一扫才是:任何一条漏了归还,它就红。
   */
  const finish = async (ids: string[], launched: string[] = ids): Promise<void> => {
    // 等的只能是**真起过审查回合**的那几条(`launched`)。别拿全部 id 去等:`armedTask` / `camper`
    // 刻意把单飞锁占在手上没还(那是它们复刻的现场),那几条永远等不到空。
    await until("在跑的回合都退干净", () => launched.every((taskId) => !turnIdentity(taskId)));
    for (const taskId of ids) {
      for (const run of await db.select({ id: freeReviewRuns.id }).from(freeReviewRuns)
        .where(eq(freeReviewRuns.taskId, taskId))) {
        // **要等,不能读一次就断言**:真投递出去的那几条,认领证是在**投递有了结局之后**才还的
        // (`giveUp` → `onFail` → `settled`),而那一段排在回合释放之后 —— 读一次的写法会随用例
        // 顺序时灵时不灵(靠后面几条用例耗的时间凑巧把它等过去)。等不到就按原话报红。
        await until(`${taskId} 的认领证收摊时还回来`, async () => !reviewDispatchArmed(run.id, 1), 5_000);
      }
    }
    if (process.env.ASH_DUMP_TIMELINE) {
      for (const taskId of ids) console.log(`\n──── ${taskId} ────\n${timeline(taskId)}`);
    }
  };

  return {
    db, freeReviewRounds, freeReviewRuns, groups, regressionEvidence, sessions, tasks,
    handleFreeWorkflowSettlement, reconcileFreeReviews, reserveFreeReview,
    claimReviewDispatch, clearReviewDispatchIntent, dispatchReviewRound, preparingReviewDispatch,
    MAX_REVIEW_DISPATCH_ATTEMPTS, releaseReviewDispatchClaim, reviewDispatchArmed, reviewDispatchOwned,
    reviewLifecycle, supersedeReviewDispatch,
    completeRegressionSettlement, regressionSettlementConclusion,
    failReviewStart, launchReviewRound, redeliverReviewRound, reopenFailedFreeReview,
    reviewOrphanStillUnowned,
    claimOwnTurn, claimTurn, continueWhenIdle, forceReleaseTurn, releaseTurn, turnIdentity, whenTurnIdle,
    evidenceState, freeReviewEvidenceDir,
    at, timeline, until, runOf, runRow, roundOf, reviewerSessions,
    freeTask, armedTask, camper, holdLifecycle, restarted, finish,
  };
}
