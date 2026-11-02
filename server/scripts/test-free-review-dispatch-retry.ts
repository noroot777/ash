// 审查派发在回合锁的释放点上抢不到位时,**重排而不是落终态**。
//
// 复现的现场(2026-10-31,任务 IZk5yKUHpR2G,run QHyF0WKIgo_h):用户点「按意见修复」,修复回合
// 02:46:18 结束 → 预约复审 02:46:19.231 写下「第 1 轮审查开始」→ 148ms 后「启动失败:回合被
// 其它执行抢占,消息未能投递」。预约在启动前就被 CAS 消费掉了,于是整条自动链就地停住,要用户
// 手动再开一轮。而「抢不到锁」是个纯瞬时条件 —— 同一个释放点上注册在前的那条 waiter 先同步
// 抢走了锁,谁先注册纯属时序运气。
//
// 十三条用例对着验收标准(台子在 `free-review-dispatch-harness.ts`):
//  ① 输一次 → 不落终态、派发意图留着、下一个空闲窗口自动重试并真的送出去;
//  ② 连输到界 → 落终态,而且终态说得出「输了几次」,每一次重排都在时间线上留了痕;
//  ③ 跨重启补办 → 库里挂着意图、内存里没人盯着(= 重启后的现场),对账补投一次而不是收尸;
//  ④ 重启前就已输光 → 落终态,理由说的是「任务书没送进会话」而不是通用的「没给出结论」;
//  ⑤ 旧路径不变 → 抢不到以外的失败(这里用分组暂停的撤回)照旧一次就落终态,不重排;
//  ⑥ 重排等的那次释放不限于「回合正常结束」 → 幽灵锁被人工放开 / 巡检拔掉时它一样被放走;
//  ⑦ **合法排队中遇上周期对账** → 不收尸、不动意图,而且那一笔重排照旧有效(第 1 轮审查 F1);
//  ⑧ (已搬到 test-idle-delivery-verdict.ts:回执的时机与三档,要能控制回执的执行器桩);
//  ⑨ 两个恢复入口同时到 → 只补投一次;而迟到的启动失败不许覆盖已有结论(第 1 轮审查 F3);
//  ⑩ 补办把**原派发的会话策略**原样重放 → 新链第 1 轮不接上一条链的旧对话(第 1 轮审查 F4);
//  ⑪ **慢一份恢复手里的旧快照** → 不许把一条已经办完的意图重建出来再投一遍(第 2 轮审查 F1);
//  ⑫ **交付凭据已确认、意图还没清** → 结清意图而不是重发任务书(第 2 轮审查 F2);
//  ⑬ **写意图那一刻版本已经变了** → 按 `attempts` 做 CAS,不写不投(第 2 轮审查 F1 的第二道);
//
// **「这一轮的这一次」那一半在隔壁** —— 代次隔离、所有权、落笔条件(⑭～⑳)在
// `test-free-review-dispatch-ownership.ts`,台子是同一个。两份分开是因为单文件七百行封顶。
//
// **不碰真 CLI**:投递成功那一刻会真走到 `continueTask`,而起真执行器由测试隔离闸拦着
// (`ASH_ALLOW_REAL_AGENT` 没设 = 直接判 turn_failed)。PATH 上那个立刻退出的 `codex` 桩管的是
// 另一段 —— ash MCP 预检会去问 CLI,有了桩这份用例就跟这台机器装没装 codex 无关。
//
// 跑：npm -w server run test:free-review-dispatch-retry
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { root, startHarness } from "./free-review-dispatch-harness.js";
import { releaseTmpDb } from "./tmp-db.js";

try {
  // 台子(临时库、桩、种子数据、夹具)都在 `free-review-dispatch-harness.ts`。
  const {
    db, freeReviewRounds, freeReviewRuns, groups, regressionEvidence, sessions, tasks,
    handleFreeWorkflowSettlement, reconcileFreeReviews, reserveFreeReview,
    claimReviewDispatch, clearReviewDispatchIntent, MAX_REVIEW_DISPATCH_ATTEMPTS,
    releaseReviewDispatchClaim, reviewDispatchArmed,
    failReviewStart, launchReviewRound, redeliverReviewRound,
    claimOwnTurn, claimTurn, continueWhenIdle, forceReleaseTurn, releaseTurn, whenTurnIdle,
    evidenceState, freeReviewEvidenceDir,
    at, timeline, until, runOf, runRow, roundOf, reviewerSessions, freeTask, armedTask, camper,
    restarted, finish,
  } = await startHarness();

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
    // 认领证由派发那一侧按回执收口时归还;意图可能先被这一轮的结算在终态事务里清掉(测试隔离闸
    // 起不来真 codex,协议层答拒收,结算当场照实收尾),所以这里等它,而不是要求两件事同一刻发生。
    await until("送出去之后本进程不再盯着它", () => !reviewDispatchArmed(run.id, 1));
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

  // ── ⑦ 合法排队中遇上周期对账:不收尸、不动意图 ────────────────────────────────
  // 第 1 轮审查 F1 的现场:审查在释放点上输给一个 single 回合、已经合法排到第二次,而对方跑得
  // 久一点(或者成为幽灵)。`reconcileFreeReviews` 每 30 秒一拍,这一拍落在那段等待里 ——
  // 「本进程有人负责等待」当初并进了「没有在途意图」那一档,于是这条链被按孤儿收尸,自动链
  // 照样断在那里。判据是**在途不等于没在干活**。
  {
    const id = "free-dispatch-reconcile";
    await armedTask(id);
    const rival = camper(id, 1);
    await handleFreeWorkflowSettlement(id, "done", true, true, "single");
    const run = await runOf(id);
    releaseTurn(id, undefined);
    await until("审查这一侧输掉一次并重排", async () => (await roundOf(run.id)).dispatch?.attempts === 2);
    assert.equal(reviewDispatchArmed(run.id, 1), true, "这一刻正有一条 waiter 排着");
    assert.ok(claimOwnTurn(id, "single") === null, "竞争者还占着回合——这正是那一拍对账看到的现场");

    await reconcileFreeReviews(id);

    assert.equal((await runRow(run.id)).status, "reviewing", "合法排队中的审查不许被对账收尸");
    const held = await roundOf(run.id);
    assert.equal(held.status, "reviewing", "同理不许把 round 落成 error");
    assert.equal(held.dispatch?.attempts, 2, "对账不该动那份在途意图（它不是孤儿，也不该被补投）");
    assert.doesNotMatch(timeline(id), /审查启动失败|未能正常给出结论/,
      "排队中被对账扫到一次，不该留下任何终态说法");
    // 而且那一笔重排没被对账搅掉:竞争者让位之后它照样把任务书交出去。
    releaseTurn(id, rival.held!);
    await until("对账之后那一笔重排仍然有效", async () => (await roundOf(run.id)).dispatch == null);
    await until("审查会话真的起来了", async () => (await reviewerSessions(id)) > 0);
    console.log("✓ ⑦ 合法排队中遇上周期对账：不收尸、不动意图，那一笔重排照旧有效");
  }

  // ── ⑧ 投递回执的时机与三档 ──────────────────────────────────────────────────
  // 已搬到 `test-idle-delivery-verdict.ts`(V1 钉「回执落定就报、不等整轮」)。这里摆不出来:测试
  // 隔离闸给的是一个起不来的子进程,codex 那一侧据此如实答「拒收」—— 从前这条用例在这个现场里
  // 断言「送出去了」,断言的正是那个被三态回执杀掉的歧义。

  // ── ⑨ 两个恢复入口同时到:只补投一次;迟到的启动失败不覆盖已有结论 ──────────────
  // 第 1 轮审查 F3:补办要重走整个 `launchReviewRound`(证据目录、工作区、MCP 预检、任务书
  // 重算),那是一长串 await。只在开头读一次「有没有人盯着」等于没有占位 —— 30 秒定时对账与
  // 单任务中断恢复落在同一段时间里,各排一份同样的任务书;而迟到那一份的失败回调又会把先那
  // 一份已经拿到的结论覆盖成「启动失败」。
  {
    const id = "free-dispatch-concurrent";
    const runId = await restarted(id, 1);
    // 两条恢复路同时进来(现场是定时对账 + task-reconcile/task-resume/task-answer 各自那条)。
    await Promise.all([reconcileFreeReviews(id), reconcileFreeReviews(id)]);
    await until("补投把意图了结", async () => (await roundOf(runId)).dispatch == null);
    assert.equal((timeline(id).match(/任务书重新投递/g) ?? []).length, 1, "同一轮只许补投一次");
    assert.equal(await reviewerSessions(id), 1, "补投两份的形状就是两条审查会话——额度要白烧一倍");
    console.log("✓ ⑨a 两个恢复入口同时到：按 run/round 原子认领，只补投一次");
  }
  {
    const id = "free-dispatch-late";
    await freeTask(id);
    const runId = `${id}-run`;
    // 这一轮**已经有结论了**(审查通过)。改之前,一条迟到的失败收尾会把它覆盖成 error/failed,
    // 界面上就是「审查通过」后面紧跟一句「审查启动失败」。
    await db.insert(freeReviewRuns).values({
      id: runId, taskId: id, reviewerId: "reviewer", reviewerName: "reviewer", agentType: "codex",
      executorId: "ex", checkMode: "logic", retryLimit: 1, currentRound: 1, status: "passed",
      createdAt: at, updatedAt: at, finishedAt: at,
    });
    await db.insert(freeReviewRounds).values({
      id: `${runId}-round`, runId, round: 1, status: "passed", conclusion: "verified",
      startedAt: at, endedAt: at,
    });
    // **身份要给对的那一个**:失败收尾的闸是两道(还停在 reviewing + 证据行就是这一代次),
    // 要钉的是前一道,所以后一道必须成立 —— 不然这几句会被「代次读不出来」顺手挡掉,
    // 断言照样绿,测的却不是「已有结论不许被改写」。
    const evidence = await evidenceState(id, freeReviewEvidenceDir(id, runId, 1),
      (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!);
    await failReviewStart(await runRow(runId), "迟到的投递失败", { generation: evidence.generation });

    assert.equal((await roundOf(runId)).status, "passed", "已有结论的轮次不许被迟到的失败改写");
    assert.equal((await roundOf(runId)).conclusion, "verified", "结论本体更不许动");
    assert.equal((await runRow(runId)).status, "passed", "run 也该原样停在 passed");
    assert.doesNotMatch(timeline(id), /审查启动失败/, "迟到的失败连一句话都不该留下（它只会和结论打架）");
    console.log("✓ ⑨b 迟到的启动失败只认「这一轮还停在 reviewing」，不覆盖已有结论");
  }

  // ── ⑩ 补办把原派发的会话策略原样重放 ──────────────────────────────────────────
  // 第 1 轮审查 F4:补办当初无条件关掉 freshSession,而没指名 resumeSessionId 时下游会按
  // agentType+role 挑**最近**的历史会话(不按 run 隔离)。于是新链第 1 轮(以及合并结果审查)
  // 本该各开一条空会话,重启补投后却接进了上一条链的旧对话 —— 同一位审查者,换了上下文。
  {
    const id = "free-dispatch-fresh";
    const runId = await restarted(id, 1, { freshSession: true });
    // 上一条链留下的那条可续审查会话(有 cliSessionId = 真的接得上)。
    await db.insert(sessions).values({
      id: `${id}-old-reviewer`, taskId: id, role: "reviewer", agentType: "codex", executor: "test",
      cwd: root, cliSessionId: "old-cli", startedAt: at, turnStartedAt: at, endedAt: at,
    });

    await reconcileFreeReviews(id);
    await until("补投把意图了结", async () => (await roundOf(runId)).dispatch == null);

    assert.equal(await reviewerSessions(id), 2, "新链第 1 轮的补办要另开会话，不许接进上一条链的旧对话");
    const old = (await db.select().from(sessions).where(eq(sessions.id, `${id}-old-reviewer`))).at(0)!;
    assert.equal(old.cliSessionId, "old-cli", "旧会话原样留着，这次补办没把它接走");
    console.log("✓ ⑩ 补办重放原派发的会话策略：新链第 1 轮仍然新开会话");
  }

  // ── ⑪ 慢一份恢复手里的旧快照:不许重建一条已经办完的意图 ──────────────────────
  // 第 2 轮审查 F1:内存认领只能证明「本进程此刻没有第二个人在办」,证不了手里那份 round 快照
  // 还是库里当前那一份。对账是先读 round、再 await 几次才走到补办的 —— 先到的一份完全可以在
  // 这期间把任务书送出去、把意图清掉、把认领也放掉,慢的那一份才从 await 里回来。它手里的快照
  // 仍写着 attempts:1,于是无条件写回去 = 把一条已经办完的派发凭空重建,接着再排一份完整任务书
  // (实测现场:审查者刚提了问题、还没等到答复,第二份任务书就开了一条新会话)。
  //
  // 「先到的那一份已经办完」直接写进库,不绕路去真跑两条恢复:要钉的就是**手里这份快照已经
  // 过期**这一个事实,而时序由构造表达比由 sleep 表达准。
  {
    const id = "free-dispatch-stale";
    const runId = await restarted(id, 1);
    const stale = await roundOf(runId);
    assert.equal(stale.dispatch?.attempts, 1, "这就是慢的那一份手里的快照");
    await db.update(freeReviewRounds).set({ dispatch: null })
      .where(eq(freeReviewRounds.id, `${runId}-round`));

    const task = (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
    const verdict = await redeliverReviewRound(task.id, await runRow(runId), stale);

    // 答 `hold` 而不是 `none`:「这份意图刚被别人办掉了」与「压根没有派发」是两件事,后者是
    // 调用方「照原路按孤儿收尸」的通行证 —— 而此刻真相恰恰相反(第 3 轮审查 F1)。
    assert.equal(verdict, "hold", "办完的那一份只能答「有人负责了」，不能答「压根没有派发」");
    assert.equal((await roundOf(runId)).dispatch, null, "更不许把已经清掉的意图写回来");
    assert.equal(await reviewerSessions(id), 0, "一个字都不该再送出去");
    assert.equal(reviewDispatchArmed(runId, 1), false, "认领要还回去，否则这一轮在本进程里永远「在途」");
    assert.doesNotMatch(timeline(id), /任务书重新投递/, "压根没补投，就不该写这一句");
    console.log("✓ ⑪ 慢一份恢复手里的旧快照：认领后按库里现读的那一份办事，不重建已办完的意图");
  }

  // ── ⑫ 交付凭据已确认、意图还没清:结清意图,不重发 ───────────────────────────
  // 第 2 轮审查 F2:投递是两次写而且不同事务 —— `commitReviewTurnDelivery` 紧挨着 spawn 之后先
  // 持久记下 deliveredReview,之后才落盘、回执、清意图。服务断在中间,留下的就是这副组合:
  // 凭据已确认 + 意图还挂着。只看意图的恢复会把这份**审查者已经读过**的任务书整份再发一遍。
  // 把回执提前到落盘那一刻只缩短了窗口,消不掉它,所以恢复必须认持久交付事实为权威。
  {
    const id = "free-dispatch-delivered";
    const runId = await restarted(id, 1);
    const directory = freeReviewEvidenceDir(id, runId, 1);
    const evidence = (await db.select().from(regressionEvidence)
      .where(eq(regressionEvidence.directory, directory))).at(0)!;
    const task = (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
    await db.update(tasks).set({
      waitOwnership: {
        deliveredReview: {
          directory, generation: evidence.generation,
          identity: { turnToken: task.activeTurnToken, directionToken: task.activeDirectionToken,
            directionEpoch: task.directionEpoch },
          confirmedAt: at,
        },
      },
    }).where(eq(tasks.id, id));

    await reconcileFreeReviews(id);

    assert.equal((await roundOf(runId)).dispatch, null, "凭据对得上就把意图结清");
    assert.equal(await reviewerSessions(id), 0, "审查者已经收到过这份任务书，不许再发一遍");
    assert.doesNotMatch(timeline(id), /任务书重新投递/, "这不是「还没送出去」，不该按补投处理");
    // 这一拍到此为止:刚被投递出去的那一份完全可能正在跑,收尸的判据这一拍说不清(第 3 轮审查 F1)。
    assert.equal((await runRow(runId)).status, "reviewing", "这一拍不收尸，等下一拍按新状态判");
    // 下一拍再来:这一次谁都没在跑、也没有意图了,「送达过又没人能跑完它」才是它真实的分类。
    await reconcileFreeReviews(id);
    assert.equal((await runRow(runId)).status, "failed", "下一拍照原路收尾");
    assert.equal(await reviewerSessions(id), 0, "收尾也不该把任务书再发一遍");
    console.log("✓ ⑫ 交付凭据已确认、意图还没清：结清意图而不是重发任务书");
  }

  // ── ⑬ 写意图那一刻版本已经变了:按版本 CAS 兜住 ──────────────────────────────
  // ⑪ 钉的是「认领之后去库里现读」那一道。可现读之后到真正写意图之间还隔着一长串准备(证据
  // 目录、工作区、MCP 预检、任务书重算),先到的那一份完全可以**在这段里**才办完 —— 那一种
  // 时序上面那次读挡不住,只能由写本身来挡:`takeIntent` 按 `attempts` 做 CAS,版本对不上就一
  // 个字都不写、把认领还回去。所以这里直接从 `launchReviewRound` 进去(它就是现读之后那一段),
  // 手里拿着一份已经过期的 attempts。
  {
    const id = "free-dispatch-cas";
    const runId = await restarted(id, 1);
    const task = (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
    const generation = (await roundOf(runId)).dispatch!.generation!;
    await db.update(freeReviewRounds).set({ dispatch: null })
      .where(eq(freeReviewRounds.id, `${runId}-round`));
    const token = claimReviewDispatch(runId, 1, generation);
    assert.ok(token, "先领证（模拟现读之后、写意图之前的那一段）");

    await launchReviewRound(task, await runRow(runId), {
      responsibility: { generation, claimToken: token!, since: at },
      redeliver: { attempts: 1, since: at, freshSession: false },
    });

    assert.equal((await roundOf(runId)).dispatch, null, "版本对不上就一个字都不写");
    assert.equal(await reviewerSessions(id), 0, "更不许把第二份任务书送出去");
    assert.equal(reviewDispatchArmed(runId, 1), false, "让出的时候认领证要还回去");
    console.log("✓ ⑬ 写意图那一刻版本已经变了：按 attempts 做 CAS，不写不投、认领还回去");
  }

  await finish(["free-dispatch-retry", "free-dispatch-exhaust", "free-dispatch-recover",
    "free-dispatch-recover-exhausted", "free-dispatch-withdrawn", "free-dispatch-ghost",
    "free-dispatch-reconcile", "free-dispatch-concurrent",
    "free-dispatch-late", "free-dispatch-fresh", "free-dispatch-stale", "free-dispatch-delivered",
    "free-dispatch-cas"],
    // 真起过审查回合的就这几条(投递成功那一刻),只等它们。
    ["free-dispatch-retry", "free-dispatch-recover", "free-dispatch-ghost", "free-dispatch-reconcile",
      "free-dispatch-concurrent", "free-dispatch-fresh"]);
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
