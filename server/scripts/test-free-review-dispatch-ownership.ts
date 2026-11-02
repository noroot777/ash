// 审查派发的身份那一半:**「这一轮的这一次」**。
//
// 重排本体(输一次不落终态、连输到界、跨重启补办…)在 `test-free-review-dispatch-retry.ts`,
// 台子是同一个(`free-review-dispatch-harness.ts`)。这一份只管一件事:同一个 round 行会被用户
// **重跑**(`reopenFailedFreeReview` 把它放回 reviewing 并换一个新的证据代次),于是「这一行」会
// 先后代表同一轮的好几次派发 —— 认领、意图、资源处置、失败收尾、孤儿收尾各自都得分得清是哪一次。
//
// 七条用例:
//  ⑭ **认领 / 清意图 / 失败收尾按代次隔离** → 上一次重跑的收尾碰不到新一次(第 3 轮审查 F2);
//  ⑮ **旧收尾还没放手时点「继续本轮审查」** → 新一次照样派得出去,不被静静吞掉(同上);
//  ⑯ **认领之后现读抛异常** → 证还回去、意图留着,健康之后补办得了(第 3 轮审查 F3);
//  ⑰ **结算之前先问一遍所有权** → 正在输出 / 有人领证 / 又挂上意图都不许收尸(第 3 轮审查 F1);
//  ⑱ **落笔那一刻按方向世代 CAS** → 判断之后又起过回合的,那一笔自己就不成立(同上,硬保证那一道);
//      **上下两个事务各核一次** → 迟到者连首次持久写(settlement/continuation)都不许落(第 4 轮审查 F1);
//  ⑲ **旧代次的收尾与重跑换代次互斥** → 要么它整段先做完,要么它进来时整段作废(第 4 轮审查 F2);
//  ⑳ **代次的权威在证据行** → 旧的那一次从长 await 里回来,覆盖不了新一代写下的意图(同上)。
//
// **不碰真 CLI**:投递成功那一刻会真走到 `continueTask`,而起真执行器由测试隔离闸拦着
// (`ASH_ALLOW_REAL_AGENT` 没设 = 直接判 turn_failed)。
//
// 跑：npm -w server run test:free-review-dispatch-ownership
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { root, startHarness } from "./free-review-dispatch-harness.js";
import { releaseTmpDb } from "./tmp-db.js";

try {
  // 台子(临时库、桩、种子数据、夹具)都在 `free-review-dispatch-harness.ts`。
  const {
    db, freeReviewRounds, freeReviewRuns, regressionEvidence, tasks,
    handleFreeWorkflowSettlement,
    claimReviewDispatch, clearReviewDispatchIntent, dispatchReviewRound,
    releaseReviewDispatchClaim, reviewDispatchArmed,
    failReviewStart, redeliverReviewRound, reopenFailedFreeReview, reviewOrphanStillUnowned,
    claimTurn, forceReleaseTurn, freeReviewEvidenceDir,
    completeRegressionSettlement, regressionSettlementConclusion,
    at, timeline, until, runRow, roundOf, reviewerSessions, holdLifecycle, restarted, finish,
  } = await startHarness();

  // ── ⑭ 认领 / 清意图 / 失败收尾按代次隔离 ──────────────────────────────────────
  // 第 3 轮审查 F2:同一个 round 行会被用户**重跑**(`reopenFailedFreeReview` 把它放回 reviewing
  // 并换新的证据代次),于是「这一行」会先后代表同一轮的好几次派发。认领只记一个布尔、清意图
  // 和失败收尾都无代次的话,上一次的收尾(它先提交终态,再做哨兵/时间线/工作区清理,中间全是
  // await)就会把新一次的证撕掉、把新一次刚写下的意图清掉、把新一次打成 error。三件事各钉一条。
  {
    const id = "free-dispatch-generation";
    const runId = await restarted(id, 1);
    const directory = freeReviewEvidenceDir(id, runId, 1);
    const g1 = (await roundOf(runId)).dispatch!.generation!;
    const g2 = `${g1}-reopened`;

    const t1 = claimReviewDispatch(runId, 1, g1);
    assert.ok(t1, "第一张证领得到");
    assert.equal(claimReviewDispatch(runId, 1, g1), null, "同代次的第二个人要被挡住");
    const t2 = claimReviewDispatch(runId, 1, g2);
    assert.ok(t2, "换了代次 = 上一次重跑的证已经没有权限，新一次直接接管");
    releaseReviewDispatchClaim(runId, 1, t1!);
    assert.equal(reviewDispatchArmed(runId, 1), true, "上一次的收尾撕不掉新一次的证");

    await db.update(freeReviewRounds).set({ dispatch: { attempts: 1, since: at, generation: g2 } })
      .where(eq(freeReviewRounds.id, `${runId}-round`));
    await clearReviewDispatchIntent(runId, 1, g1);
    assert.ok((await roundOf(runId)).dispatch, "上一代次清不掉新一代次的意图");
    await clearReviewDispatchIntent(runId, 1, g2);
    assert.equal((await roundOf(runId)).dispatch, null, "自己那一代次照常清");
    releaseReviewDispatchClaim(runId, 1, t2!);

    // 证据行换代次 = 用户重跑过这一轮(`restartRegressionEvidence` 做的就是这一下)。
    await db.update(regressionEvidence).set({ generation: g2 })
      .where(eq(regressionEvidence.directory, directory));
    await failReviewStart(await runRow(runId), "上一代次的迟到失败", { generation: g1 });
    assert.equal((await roundOf(runId)).status, "reviewing", "上一代次的迟到失败不许打断重跑起来的那一次");
    assert.equal((await runRow(runId)).status, "reviewing", "run 也不许被它改掉");
    await failReviewStart(await runRow(runId), "这一代次自己的失败", { generation: g2 });
    assert.equal((await roundOf(runId)).status, "error", "自己那一代次照常落账");
    console.log("✓ ⑭ 认领 / 清意图 / 失败收尾按代次隔离：上一次重跑的收尾碰不到新一次");
  }

  // ── ⑮ 旧收尾还没放手时点「继续本轮审查」 ─────────────────────────────────────
  // 第 3 轮审查 F2 的用户现场:上一次失败**已经提交**(界面和重试闸都放行了),它的收尾还在做
  // 哨兵/时间线/工作区清理 —— 认领证就在这个合法窗口里挂着。那时点「继续本轮审查」,老写法把
  // 新一次当成重复派发静默吞掉(HTTP 还回 202),于是 reviewing + 没有意图 + 没有等待者,三十秒
  // 后被对账按孤儿收掉。这里要的就是「它真的派出去了」。
  {
    const id = "free-dispatch-reopen";
    const runId = await restarted(id, 1);
    const stale = (await roundOf(runId)).dispatch!.generation!;
    await db.update(freeReviewRounds).set({ status: "error", dispatch: null, endedAt: at })
      .where(eq(freeReviewRounds.id, `${runId}-round`));
    await db.update(freeReviewRuns).set({ status: "failed", finishedAt: at }).where(eq(freeReviewRuns.id, runId));
    const held = claimReviewDispatch(runId, 1, stale);
    assert.ok(held, "上一次的认领证还挂着（它的收尾还没做完）");

    const { dispatched } = await reopenFailedFreeReview(id);

    assert.equal(dispatched, true, "新一次必须真的派出去，不许被上一次的证静静吞掉");
    assert.doesNotMatch(timeline(id), /没有另起投递/, "这一次是真派出去了，不该写那句让出");
    // **任务书真的走到了投递那一步**:沙箱里起不了真执行器,所以它以「启动失败」收场 —— 关键
    // 是这一句只可能由投递那一侧写出来。缺陷形态恰恰相反:一个字都没送、也没有任何交代,
    // round 停在 reviewing + 没有意图 + 没人等着,三十秒后才被对账按孤儿收掉。
    // 投递是异步的(`continueWhenIdle` 排完就返回),所以等它真的落到一条审查会话上再问。
    // 缺陷形态在这里永远等不到:一个字都没送出去,round 停在 reviewing + 没有意图 + 没人等着,
    // 三十秒后才被对账按孤儿收掉。
    await until("任务书送进一条审查会话", async () => await reviewerSessions(id) === 1);
    releaseReviewDispatchClaim(runId, 1, held!);
    console.log("✓ ⑮ 旧收尾还没放手时点「继续本轮审查」：新一次照样派得出去");
  }

  // ── ⑯ 认领之后现读抛异常:证还回去、意图留着 ─────────────────────────────────
  // 第 3 轮审查 F3:领证到「责任交给等待者」之间每一步都可能抛(现读、凭据查询、耗尽收尾)。
  // 抛了不还证,`armed` 就从「有人负责等待」退化成一条谁都读不懂的真值 —— 对账见它就跳过,
  // 库里那份没消费的意图再也没人补办,数据库早恢复健康也救不回来,只能靠重启丢掉内存。
  // 一次瞬时读库故障也不该把这一轮打成失败:那是拿一次锁争用换掉一轮审查。
  {
    const id = "free-dispatch-claim-leak";
    const runId = await restarted(id, 1);
    const task = (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
    const run = await runRow(runId);
    const round = await roundOf(runId);
    // 先把要用的行全读出来再下钩子:钩子按**第几次 select** 认人 —— 第 1 次是读代次(领证之前),
    // 第 2 次正是领证之后那一条现读。
    const patched = db as unknown as { select: typeof db.select };
    const original = db.select.bind(db);
    let calls = 0;
    patched.select = ((...args: Parameters<typeof db.select>) => {
      if (++calls === 2) throw new Error("注入：SQLITE_BUSY");
      return original(...args);
    }) as typeof db.select;
    let verdict: string;
    try {
      verdict = await redeliverReviewRound(task, run, round);
    } finally {
      delete (patched as Partial<typeof patched>).select;
    }

    assert.equal(verdict, "hold", "一次瞬时读库故障不该把这一轮打成失败");
    assert.equal(reviewDispatchArmed(runId, 1), false, "认领证必须还回去");
    assert.ok((await roundOf(runId)).dispatch, "没消费的意图原样留着");
    assert.equal((await roundOf(runId)).status, "reviewing", "一个终态都别写");
    assert.equal((await runRow(runId)).status, "reviewing", "run 也别动");
    // 数据库已经健康了,下一拍照样补办得了 —— 这才是「异常之后还能自愈」的判据。
    assert.equal(await redeliverReviewRound(task, await runRow(runId), await roundOf(runId)), "handled",
      "健康之后的那一拍该接着办");
    await until("补办真的把任务书送出去了", async () => await reviewerSessions(id) === 1);
    console.log("✓ ⑯ 认领之后现读抛异常：证还回去、意图留着，健康之后补办得了");
  }

  // ── ⑰ 结算下笔之前再问一次所有权 ────────────────────────────────────────────
  // 第 3 轮审查 F1:对账那一串判据是异步的 —— 开头读一次「reviewer 活着吗」,之后还要 await
  // 退役检查、轮次读取、等待检查、补办。两份恢复同时进来时,快的那一份完全可以在这期间把任务书
  // 送进会话、拉起审查者;慢的那一份带着开头那个「没人在跑」的结论一路走到收尾,把一条**正在
  // 输出**的审查落成 failed/error。**失去投递权不等于获得结算权**,所以下笔之前按此刻的状态
  // 再问一遍。四种形状各钉一条(前三种都曾能一路走到结算)。
  {
    const id = "free-dispatch-settle-guard";
    const runId = await restarted(id, 1);
    await db.update(freeReviewRounds).set({ dispatch: null })
      .where(eq(freeReviewRounds.id, `${runId}-round`));
    const run = await runRow(runId);
    assert.ok(await reviewOrphanStillUnowned(run), "谁都没在管：这一拍确实该它收尾");

    assert.equal(claimTurn(id, "reviewer", { run: runId, round: 1 }), true, "审查者刚起来");
    assert.equal(await reviewOrphanStillUnowned(run), null, "正在输出的审查不许被收尸");
    forceReleaseTurn(id);

    const token = claimReviewDispatch(runId, 1, "g-another");
    assert.equal(await reviewOrphanStillUnowned(run), null, "刚有人领证接手这一轮，就不是孤儿");
    releaseReviewDispatchClaim(runId, 1, token!);

    await db.update(freeReviewRounds).set({ dispatch: { attempts: 1, since: at } })
      .where(eq(freeReviewRounds.id, `${runId}-round`));
    assert.equal(await reviewOrphanStillUnowned(run), null, "又挂上在途意图的轮次归补投管");

    await db.update(freeReviewRounds).set({ dispatch: null, status: "passed" })
      .where(eq(freeReviewRounds.id, `${runId}-round`));
    assert.equal(await reviewOrphanStillUnowned(run), null, "已经落了终态的轮次不该再被收尾");
    console.log("✓ ⑰ 结算之前先问一遍所有权：正在输出 / 有人领证 / 又挂上意图都不收尸");
  }

  // ── ⑱ 落笔那一刻按方向世代 CAS ───────────────────────────────────────────────
  // ⑰ 那一问再细也只是「检查完再动手」——读完到提交之间仍然隔着几次 await,而那正是这条缺陷
  // 的形状。硬保证得写进落笔那个事务:判断时手里的 `directionEpoch` 当条件核,而每个回合起跑
  // (含审查旁路回合)都在自己那笔事务里把这一格 +1(`turnDirectionStart`),所以「这中间有回合
  // 起来了」和「这一笔写得成」互斥 —— 两份恢复怎么交错都不可能判死一条正在输出的审查。
  //
  // 这里直接把那一格 +1 来代表「另一份恢复刚把任务书送进会话、审查者回合起来了」:要钉的就是
  // **落笔条件**本身,而真起一个回合除了把这一格 +1 之外还会带来一堆与这一问无关的状态。
  {
    const id = "free-dispatch-fence";
    const runId = await restarted(id, 1);
    await db.update(freeReviewRounds).set({ dispatch: null })
      .where(eq(freeReviewRounds.id, `${runId}-round`));
    const run = await runRow(runId);
    const fence = await reviewOrphanStillUnowned(run);
    assert.ok(fence, "判断那一刻确实没人管");

    await db.update(tasks).set({ directionEpoch: fence!.directionEpoch + 1 }).where(eq(tasks.id, id));
    await handleFreeWorkflowSettlement(id, "done", false, null, "reviewer", true, false, fence!);
    assert.equal((await runRow(runId)).status, "reviewing", "迟到的收尾一个字都不许写");
    assert.equal((await roundOf(runId)).status, "reviewing", "轮次也不许被它改掉");
    // **结算是两段式的**:round/run 那一笔之前,上半场(`regressionSettlementConclusion`)就已经把
    // `settlement={outcome:failed,pending:true}` 和 `continuation.phase=exited` 写进证据行了。
    // 只守下半场的话,这两行照样被迟到者写成失败 —— 那条正在输出的审查随后上报结论会被
    // 「本轮已进入结算,不能更改结论」拒掉,正常退出也沿用这份 settlement,最终那道闸撤回的只是
    // round/run(第 4 轮审查 F1 实测)。所以这里要问的是「证据行一个字都没动」。
    const poisoned = (await db.select().from(regressionEvidence)
      .where(eq(regressionEvidence.directory, freeReviewEvidenceDir(id, runId, 1)))).at(0)!;
    assert.equal(poisoned.settlement, null, "迟到者连首次持久写都不许落:结算状态必须还是空的");
    assert.equal(poisoned.continuation?.phase, "running",
      "续跑相位也不许被它改成 exited（审查者还在跑）");

    // 没人插队时,同一条路照常把它收掉 —— 闸挡的是迟到者,不是收尾本身。
    const again = await reviewOrphanStillUnowned(run);
    assert.ok(again, "这一拍仍然没人管");
    await handleFreeWorkflowSettlement(id, "done", false, null, "reviewer", true, false, again!);
    assert.equal((await runRow(runId)).status, "failed", "没人插队时照常收尾");

    // 乙:**下半场那一次核也得留着**。上半场一旦放行(判断那一刻确实没人管),`checked` 就带着
    // 这个条件进入下半场 —— 而两段之间还隔着结论复核、时间线这些 await,审查者完全可以在那里
    // 被另一份恢复拉起来。只守上半场的话,这一笔仍会把 round/run 落成终态。
    const commit = "free-dispatch-fence-commit";
    const commitRun = await restarted(commit, 1);
    const commitDir = freeReviewEvidenceDir(commit, commitRun, 1);
    await db.update(freeReviewRounds).set({ dispatch: null })
      .where(eq(freeReviewRounds.id, `${commitRun}-round`));
    const held = await reviewOrphanStillUnowned(await runRow(commitRun));
    assert.ok(held, "判断那一刻没人管");
    const checked = await regressionSettlementConclusion(commit, commitDir, {
      round: 1, freeRoundId: `${commitRun}-round`, ignoreActive: true, fence: held!,
    });
    assert.ok(checked, "闸成立时上半场照常把这一笔记下来");
    await db.update(tasks).set({ directionEpoch: held!.directionEpoch + 1 }).where(eq(tasks.id, commit));
    assert.equal(await completeRegressionSettlement(commitDir, checked!), false,
      "上下两段之间起过回合:下半场这一笔也不许落");
    await db.update(tasks).set({ directionEpoch: held!.directionEpoch }).where(eq(tasks.id, commit));
    assert.equal(await completeRegressionSettlement(commitDir, checked!), true,
      "没人插队时同一笔照常落定 —— 闸挡的是迟到者,不是结算本身");
    console.log("✓ ⑱ 落笔那一刻按方向世代 CAS：判断之后又起过回合的，那一笔自己不成立");
  }

  // ── ⑲ 旧代次的收尾与「重跑换代次」互斥 ──────────────────────────────────────
  // 第 4 轮审查 F2:⑭ 那道代次闸只管得住**落账那一笔**。它提交之后,这一轮在重试闸眼里已经是
  // 合法的 failed/error,用户随时可以点「继续本轮审查」——而收尾接着要做的哨兵停收、待发结果
  // 作废、合并结果审查工作区删除全是 **run 级**的,一个代次都不认。于是旧收尾把新一代刚挂上的
  // 哨兵停掉、把它等的结果作废(实测:新哨兵 running → stopped,新一代审查者还在跑,它要等的
  // 结果再也不会来)。清理之前再读一次代次救不了:读完到下刀之间还隔着仓库锁和 git 命令。
  // 两种时序各钉一条 —— 甲「收尾先排上」要真的把重跑挡在后面,乙「重跑先换完」要让旧收尾整段作废。
  {
    // 甲:链被占住时,收尾一步都不许往前走(否则它压根没排在这条链上,乙那一条也就无从成立)。
    const id = "free-dispatch-lifecycle";
    const runId = await restarted(id, 1);
    const own = (await roundOf(runId)).dispatch!.generation!;
    const gate = holdLifecycle(runId);
    const settling = failReviewStart(await runRow(runId), "这一代次自己的失败", { generation: own });
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await roundOf(runId)).status, "reviewing", "生命周期链被占住时,收尾必须排队等着");
    gate.open();
    await gate.done;
    await settling;
    assert.equal((await roundOf(runId)).status, "error", "放手之后照常收尾 —— 互斥不是把它吞掉");

    // 乙:重跑先换了代次。排在后面的旧收尾进来时,代次闸整段把它挡住 —— 落账、哨兵/工作区清理、
    // 那句失败说明全都不发生(资源处置就在被挡住的这一段里,所以它碰不到新一代的任何东西)。
    const late = "free-dispatch-lifecycle-late";
    const lateRun = await restarted(late, 1);
    const stale = (await roundOf(lateRun)).dispatch!.generation!;
    const reopen = holdLifecycle(lateRun, async () => {
      // `reopenFailedFreeReview` 换代次做的就是这一下(`restartRegressionEvidence`)。
      await db.update(regressionEvidence).set({ generation: `${stale}-reopened` })
        .where(eq(regressionEvidence.directory, freeReviewEvidenceDir(late, lateRun, 1)));
    });
    const lateFail = failReviewStart(await runRow(lateRun), "上一代次的迟到失败", { generation: stale });
    reopen.open();
    await reopen.done;
    await lateFail;
    assert.equal((await roundOf(lateRun)).status, "reviewing", "重跑起来的那一次不许被旧收尾打成 error");
    assert.equal((await runRow(lateRun)).status, "reviewing", "run 也不许被它改掉");
    assert.doesNotMatch(timeline(late), /审查启动失败/,
      "连那句失败说明都不许迟到地写出来 —— 用户会在一条正在跑的审查上看到上一次的失败");

    // 丙:**生产那一侧的换代次真的排在这条链上**。甲乙都是拿 `holdLifecycle` 代表重跑,它们钉不住
    // 「`reopenFailedFreeReview` 自己有没有进链」—— 那一处漏了的话,互斥只剩一半(旧收尾排队,
    // 换代次照旧想换就换)。所以这里反过来:先占住链,再真点一次「继续本轮审查」。
    const reopened = "free-dispatch-lifecycle-reopen";
    const reopenedRun = await restarted(reopened, 1);
    await db.update(freeReviewRounds).set({ status: "error", dispatch: null, endedAt: at })
      .where(eq(freeReviewRounds.id, `${reopenedRun}-round`));
    await db.update(freeReviewRuns).set({ status: "failed", finishedAt: at })
      .where(eq(freeReviewRuns.id, reopenedRun));
    const busy = holdLifecycle(reopenedRun);
    const retrying = reopenFailedFreeReview(reopened);
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await roundOf(reopenedRun)).status, "error",
      "链被占住时,换代次那一笔必须排队等着 —— 否则旧收尾仍可能落在新一代资源上");
    busy.open();
    await busy.done;
    assert.equal((await retrying).dispatched, true, "放手之后照常重跑并派出去");
    assert.equal((await roundOf(reopenedRun)).status, "reviewing", "这一轮回到进行中");
    console.log("✓ ⑲ 旧代次的收尾与重跑换代次互斥：要么先做完，要么进来时整段作废");
  }

  // ── ⑳ 代次的权威在证据行:不同代次 ≠ 更新的代次 ──────────────────────────────
  // 第 4 轮审查 F2 的另一半:认领与写意图原先只比「两份代次一不一样」,方向是反的也照样放行。
  // 旧的那一次 launch 在读完证据行之后卡住(MCP 预检、任务书重算都是长 await),这一轮期间失败
  // 并被重跑,它从 await 里回来仍然以为自己是当事人 —— 于是反向夺走认领、把新一代写下的意图
  // 覆盖掉。权威只有一个:证据行此刻那一代次,而且必须跟写意图同在一条 WHERE 里。
  {
    const id = "free-dispatch-authority";
    const runId = await restarted(id, 1);
    const directory = freeReviewEvidenceDir(id, runId, 1);
    const stale = (await roundOf(runId)).dispatch!.generation!;
    const fresh = `${stale}-reopened`;
    // 现场:用户重跑过这一轮(证据行换了代次),新一次也已经把自己的意图写下了。
    await db.update(regressionEvidence).set({ generation: fresh })
      .where(eq(regressionEvidence.directory, directory));
    await db.update(freeReviewRounds).set({ dispatch: { attempts: 1, since: at, generation: fresh } })
      .where(eq(freeReviewRounds.id, `${runId}-round`));

    // 旧的那一次从长 await 里回来。`launchReviewRound` 会自己现读代次(拿到的就是新的那个),
    // 所以这里直接从派发层进去 —— 它要表达的恰恰是「手里攥着一个已经过期的代次」。
    const outcome = await dispatchReviewRound({
      taskId: id, run: { id: runId, currentRound: 1 }, label: "自由工作流第 1 轮",
      message: "上一次重跑的任务书", generation: stale,
      // 投递压根到不了(让出发生在排队之前),所以这一组不参与这条用例。
      opts: {} as never,
      onFail: async () => assert.fail("过期的那一次不该走到落终态"),
    });

    assert.equal(outcome, "handed-off", "过期的那一次只能让出");
    assert.equal((await roundOf(runId)).dispatch?.generation, fresh, "新一代写下的意图不许被它覆盖");
    assert.equal(await reviewerSessions(id), 0, "更不许把上一次的任务书送出去");
    assert.equal(reviewDispatchArmed(runId, 1), false, "让出的时候认领证要还回去");
    console.log("✓ ⑳ 代次的权威在证据行：旧的那一次覆盖不了新一代写下的意图");
  }

  await finish(["free-dispatch-generation", "free-dispatch-reopen", "free-dispatch-claim-leak",
    "free-dispatch-settle-guard", "free-dispatch-fence", "free-dispatch-lifecycle",
    "free-dispatch-fence-commit", "free-dispatch-lifecycle-late", "free-dispatch-lifecycle-reopen",
    "free-dispatch-authority"],
    ["free-dispatch-reopen", "free-dispatch-claim-leak", "free-dispatch-lifecycle-reopen"]);
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
