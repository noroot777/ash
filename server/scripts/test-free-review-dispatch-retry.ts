// 审查派发在回合锁的释放点上抢不到位时,**重排而不是落终态**。
//
// 复现的现场(2026-10-31,任务 IZk5yKUHpR2G,run QHyF0WKIgo_h):用户点「按意见修复」,修复回合
// 02:46:18 结束 → 预约复审 02:46:19.231 写下「第 1 轮审查开始」→ 148ms 后「启动失败:回合被
// 其它执行抢占,消息未能投递」。预约在启动前就被 CAS 消费掉了,于是整条自动链就地停住,要用户
// 手动再开一轮。而「抢不到锁」是个纯瞬时条件 —— 同一个释放点上注册在前的那条 waiter 先同步
// 抢走了锁,谁先注册纯属时序运气。
//
// 五条用例对着验收标准:
//  ① 输一次 → 不落终态、派发意图留着、下一个空闲窗口自动重试并真的送出去;
//  ② 连输到界 → 落终态,而且终态说得出「输了几次」,每一次重排都在时间线上留了痕;
//  ③ 跨重启补办 → 库里挂着意图、内存里没人盯着(= 重启后的现场),对账补投一次而不是收尸;
//  ④ 重启前就已输光 → 落终态,理由说的是「任务书没送进会话」而不是通用的「没给出结论」;
//  ⑤ 旧路径不变 → 抢不到以外的失败(这里用分组暂停的撤回)照旧一次就落终态,不重排;
//  ⑥ 重排等的那次释放不限于「回合正常结束」 → 幽灵锁被人工放开 / 巡检拔掉时它一样被放走。
//
// **不碰真 CLI**:投递成功那一刻会真走到 `continueTask`,而起真执行器由测试隔离闸拦着
// (`ASH_ALLOW_REAL_AGENT` 没设 = 直接判 turn_failed)。PATH 上那个立刻退出的 `codex` 桩管的是
// 另一段 —— ash MCP 预检会去问 CLI,有了桩这份用例就跟这台机器装没装 codex 无关。
//
// 跑：npm -w server run test:free-review-dispatch-retry
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-review-dispatch-"));
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

try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  const { agents, freeReviewRounds, freeReviewRuns, groups, projects, reviewerProfiles, sessions, tasks } =
    await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { handleFreeWorkflowSettlement, reconcileFreeReviews, reserveFreeReview } =
    await import("../src/free-workflow.js");
  const { MAX_REVIEW_DISPATCH_ATTEMPTS, reviewDispatchArmed } = await import("../src/free-review-dispatch.js");
  const { claimOwnTurn, claimTurn, releaseTurn, whenTurnIdle } = await import("../src/runs.js");
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

  // ── ① 输一次:不落终态、意图留着、下一个空闲窗口自动重试成功 ──────────────────
  {
    const id = "free-dispatch-retry";
    await armedTask(id);
    const rival = camper(id, 1);

    // 结算按预约派审:建好 run/round、写下「审查开始」,投递排进回合锁的等待队列。
    await handleFreeWorkflowSettlement(id, "done", true, true, "single");
    const run = await runOf(id);
    assert.ok(run, "预约被消费之后应当有一条审查链");
    assert.equal(run.status, "reviewing", "派发那一刻 run 就该挂在 reviewing");
    assert.equal(reviewDispatchArmed(run.id, 1), true, "本进程正盯着这一轮的派发");
    const first = (await roundOf(run.id)).dispatch;
    assert.equal(first?.attempts, 1, "交出去一次就该记一次");
    assert.ok(first?.since, "要记下等待的起点");

    releaseTurn(id, undefined); // 结算所在的那一轮退出 → 竞争者先抢到锁，审查这一侧抢不到
    assert.ok(rival.held, "竞争者应当在释放点上拿到锁");
    await until("审查这一侧输掉一次并重排", async () => (await roundOf(run.id)).dispatch?.attempts === 2);

    // 判据的核心:**输了一次之后一个终态都没落**，而意图原样留着。
    assert.equal((await runRow(run.id)).status, "reviewing", "抢不到回合是瞬时条件，不许把 run 落成 failed");
    const lost = await roundOf(run.id);
    assert.equal(lost.status, "reviewing", "同理不许把 round 落成 error");
    assert.equal(lost.endedAt, null, "没结束就不该写结束时刻");
    assert.equal(lost.dispatch?.attempts, 2, "意图留着，而且记下了这是第二次尝试");
    assert.equal(lost.dispatch?.since, first?.since, "等待起点沿用第一次，重排不把它重置掉");
    assert.equal(await reviewerSessions(id), 0, "输掉的那一次一个字都没送出去，不该留下审查会话");
    const noted = timeline(id);
    assert.match(noted, /任务书还没能送进会话/, "每一次重排都要留在时间线上（刷新后还看得见）");
    assert.match(noted, /第 1 次/, "要说清这是输的第几次");
    assert.doesNotMatch(noted, /审查启动失败/, "没放弃就不许写「启动失败」——那是终态的说法");

    // 竞争者那一轮退出 → 重排的这一笔在同一把锁上拿到位,真的把任务书交了出去。
    releaseTurn(id, rival.held!);
    await until("意图被了结（任务书送进会话）", async () => (await roundOf(run.id)).dispatch == null);
    assert.equal(reviewDispatchArmed(run.id, 1), false, "送出去之后本进程不再盯着它");
    await until("审查会话真的起来了", async () => (await reviewerSessions(id)) > 0);
    assert.doesNotMatch(timeline(id), /审查启动失败/, "送出去了就不该留下一句启动失败");
    console.log("✓ ① 释放点上输一次：不落终态、意图留着、下一个空闲窗口自动重试并送出");
  }

  // ── ② 连输到界:有界、每次有痕、终态有原因 ──────────────────────────────────
  {
    const id = "free-dispatch-exhaust";
    await armedTask(id);
    const rival = camper(id, MAX_REVIEW_DISPATCH_ATTEMPTS);

    await handleFreeWorkflowSettlement(id, "done", true, true, "single");
    const run = await runOf(id);

    releaseTurn(id, undefined);
    for (let attempt = 2; attempt <= MAX_REVIEW_DISPATCH_ATTEMPTS; attempt++) {
      await until(`输掉第 ${attempt - 1} 次并重排`, async () => (await roundOf(run.id)).dispatch?.attempts === attempt);
      assert.equal((await runRow(run.id)).status, "reviewing", `第 ${attempt - 1} 次输掉还不该落终态`);
      releaseTurn(id, rival.held!); // 竞争者让位,但它已经把自己重排在队首,所以审查又输一次
    }
    await until("界用尽后落终态", async () => (await runRow(run.id)).status === "failed");

    const dead = await roundOf(run.id);
    assert.equal(dead.status, "error", "界用尽了才轮到终态");
    assert.ok(dead.endedAt, "终态要有结束时刻");
    assert.equal(dead.dispatch, null, "放弃时意图要了结，否则重启后的对账会再投一次");
    assert.equal(await reviewerSessions(id), 0, "从头到尾一个字都没送出去");
    const said = timeline(id);
    assert.match(said, /已连续重排 3 次/, "终态必须说得出输了几次");
    assert.match(said, /审查启动失败/, "放弃了才写「启动失败」");
    assert.equal((said.match(/任务书还没能送进会话/g) ?? []).length, MAX_REVIEW_DISPATCH_ATTEMPTS - 1,
      "每一次重排都要留一条痕，不是只在最后说一句");
    console.log("✓ ② 连输到界：有界、每一次都有痕、终态说得出原因");
  }

  /**
   * 上一个进程死在「任务书交出去了、还没送进会话」中间之后,库里剩下的就是这副样子:run/round
   * 都挂在 reviewing、round 上挂着一份在途意图,而**内存里没有任何人盯着它**。
   *
   * 直接写库而不是「先派发再抹掉内存」:那张 armed 表是私有的,从外面抹不掉;而这副样子本身
   * 就是重启后的全部事实,照着摆出来比绕路更准。
   */
  const restarted = async (id: string, attempts: number) => {
    await freeTask(id);
    const runId = `${id}-run`;
    await db.insert(freeReviewRuns).values({
      id: runId, taskId: id, reviewerId: "reviewer", reviewerName: "reviewer", agentType: "codex",
      executorId: "ex", checkMode: "logic", retryLimit: 1, currentRound: 1, status: "reviewing",
      createdAt: at, updatedAt: at,
    });
    await db.insert(freeReviewRounds).values({
      id: `${runId}-round`, runId, round: 1, status: "reviewing", startedAt: at,
      dispatch: { attempts, since: at, resumeSessionId: null },
    });
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, id));
    // 这一行是 `launchReviewRound` 开头就落下的（`evidenceState`），所以重启后的现场一定有它。
    // 少了它,这一轮会先被「历史审查退役」判据捞走(没有锚定的 targetIdentity = 当成老链收尸),
    // 压根走不到派发补办那一步。
    await evidenceState(id, freeReviewEvidenceDir(id, runId, 1),
      (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!);
    assert.equal(reviewDispatchArmed(runId, 1), false, "重启后的内存里没有任何人盯着它");
    return runId;
  };

  // ── ③ 跨重启补办:库里挂着意图、内存里没人盯着 → 对账补投一次,不收尸 ───────────
  {
    const id = "free-dispatch-recover";
    const runId = await restarted(id, 1);
    await reconcileFreeReviews(id);
    await until("补投把意图了结", async () => (await roundOf(runId)).dispatch == null);
    await until("审查会话真的起来了", async () => (await reviewerSessions(id)) > 0);
    const said = timeline(id);
    assert.match(said, /任务书重新投递/, "补投要在时间线上说清它是补的");
    // **顺序就是判据**:补投那一句必须排在任何收尾说明之前。反过来(先收尸、再补投)说明对账
    // 把「一个字都没收到」当成了「跑完了没交卷」—— 那正是改之前这一轮会落到的下场。
    // (补投之后那一轮审查自己跑失败是另一件事:本机测试环境不许起真执行器,所以它必然失败,
    //  那条「未能正常给出结论」是**真跑过一轮**的结论,不是收尸。)
    const redelivered = said.indexOf("任务书重新投递");
    const concluded = said.indexOf("未能正常给出结论");
    assert.ok(concluded === -1 || redelivered < concluded, "补投必须发生在收尾之前，不能被收尸抢先");
    console.log("✓ ③ 跨重启：库里挂着意图而内存里没人盯着 → 对账补投一次，不收尸");
  }

  // ── ④ 重启前就已输光:落终态,而且理由说的是「任务书没送进会话」 ────────────────
  {
    const id = "free-dispatch-recover-exhausted";
    const runId = await restarted(id, MAX_REVIEW_DISPATCH_ATTEMPTS);
    await reconcileFreeReviews(id);
    assert.equal((await runRow(runId)).status, "failed", "界用尽了就该落终态，不许永远补投下去");
    assert.equal((await roundOf(runId)).status, "error");
    assert.equal((await roundOf(runId)).dispatch, null, "终态之后意图要了结");
    assert.equal(await reviewerSessions(id), 0, "界用尽的那条链不该再起审查会话");
    assert.match(timeline(id), /始终没能送进会话/,
      "终态理由要说「任务书一个字都没送到」，而不是通用的「未能正常给出结论」");
    console.log("✓ ④ 界用尽的链重启后落终态，而且理由说的是「任务书没送进会话」");
  }

  // ── ⑤ 旧路径不变:抢不到以外的失败照旧一次就落终态 ──────────────────────────
  {
    const id = "free-dispatch-withdrawn";
    await armedTask(id);
    await handleFreeWorkflowSettlement(id, "done", true, true, "single");
    const run = await runOf(id);
    assert.equal((await roundOf(run.id)).dispatch?.attempts, 1);

    // 分组暂停 = 起跑前的冻结闸撤回。那是用户的决定,重排只会把它磨掉,所以必须一次落终态。
    await db.update(groups).set({ paused: true }).where(eq(groups.id, "g"));
    releaseTurn(id, undefined);
    await until("撤回一次就落终态", async () => (await runRow(run.id)).status === "failed");
    assert.equal((await roundOf(run.id)).status, "error", "撤回不是「轮不到我们」，不重排");
    assert.equal((await roundOf(run.id)).dispatch, null, "落终态要把意图一并了结");
    const said = timeline(id);
    assert.match(said, /审查启动失败/, "撤回照旧按启动失败上报");
    assert.match(said, /启动前被撤回/, "而且要说清一个字都还没送出去");
    assert.doesNotMatch(said, /任务书还没能送进会话/, "撤回不该写成「正在重排」");
    assert.doesNotMatch(said, /已连续重排/, "撤回不是用完了重试次数");
    await db.update(groups).set({ paused: false }).where(eq(groups.id, "g"));
    console.log("✓ ⑤ 撤回这几种：行为与改之前一致，一次落终态，不重排");
  }
  // ── ⑥ 重排等的那次释放**不限于「回合正常结束」** ───────────────────────────────
  // 现场里抢赢的那一位完全可能是个幽灵:占了锁却什么都没起,于是它永远没有「下一次回合结束」。
  // 所以重排不能挂在结算钩子上,只能挂回合锁自己的 afterTurn —— 人工放开(`POST
  // /tasks/:id/reclaim-turn`)和幽灵锁巡检用的 `forceReleaseTurn` 走的是同一个 `endOwnTurn`,
  // 一样会放等待者走。这一条就是钉住那个等价性。
  {
    const id = "free-dispatch-ghost";
    await armedTask(id);
    const rival = camper(id, 1);
    await handleFreeWorkflowSettlement(id, "done", true, true, "single");
    const run = await runOf(id);
    releaseTurn(id, undefined);
    await until("输给那位占锁者", async () => (await roundOf(run.id)).dispatch?.attempts === 2);

    // 它从此不动了(不 releaseTurn,模拟「占了锁什么都没起」),只能由旁人按快照条件拔掉。
    const pulled = forceReleaseTurn({ taskId: id, seq: rival.held!.seq });
    assert.ok(pulled, "按快照条件拔锁应当成功");
    await until("拔锁同样把重排的那一笔放走", async () => (await roundOf(run.id)).dispatch == null);
    await until("审查会话真的起来了", async () => (await reviewerSessions(id)) > 0);
    console.log("✓ ⑥ 幽灵锁被人工放开 / 巡检拔掉时，重排的那一笔同样被放走（不只靠「回合正常结束」）");
  }
  if (process.env.ASH_DUMP_TIMELINE) {
    for (const id of ["free-dispatch-retry", "free-dispatch-exhaust", "free-dispatch-recover",
      "free-dispatch-recover-exhausted", "free-dispatch-withdrawn", "free-dispatch-ghost"]) {
      console.log(`\n──── ${id} ────\n${timeline(id)}`);
    }
  }
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
