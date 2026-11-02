// 审查派发的身份那一半:**「这一轮的这一次」**。
//
// 重排本体(输一次不落终态、连输到界、跨重启补办…)在 `test-free-review-dispatch-retry.ts`,
// 台子是同一个(`free-review-dispatch-harness.ts`)。这一份只管一件事:同一个 round 行会被用户
// **重跑**(`reopenFailedFreeReview` 把它放回 reviewing 并换一个新的证据代次),于是「这一行」会
// 先后代表同一轮的好几次派发 —— 认领、意图、资源处置、失败收尾、孤儿收尾各自都得分得清是哪一次。
//
// 十四条用例:
//  ⑭ **认领 / 清意图 / 失败收尾按代次隔离** → 上一次重跑的收尾碰不到新一次(第 3 轮审查 F2);
//  ⑮ **旧收尾还没放手时点「继续本轮审查」** → 新一次照样派得出去,不被静静吞掉(同上);
//  ⑯ **认领之后现读抛异常** → 证还回去、意图留着,健康之后补办得了(第 3 轮审查 F3);
//  ⑰ **结算之前先问一遍所有权** → 正在输出 / 有人领证 / 又挂上意图都不许收尸(第 3 轮审查 F1);
//  ⑱ **落笔那一刻按方向世代 CAS** → 判断之后又起过回合的,那一笔自己就不成立(同上,硬保证那一道);
//      **上下两个事务各核一次** → 迟到者连首次持久写(settlement/continuation)都不许落(第 4 轮审查 F1);
//  ⑲ **旧代次的收尾与重跑换代次互斥** → 要么它整段先做完,要么它进来时整段作废(第 4 轮审查 F2);
//  ⑳ **代次的权威在证据行** → 旧的那一次从长 await 里回来,覆盖不了新一代写下的意图(同上);
//  ㉑ **旧那一次挤不掉新一次的认领** → 内存那一半也有权威,不是「谁后来谁有理」(第 1 轮审查问题 1);
//  ㉒ **准备阶段就有人负责** → 任务书还在算的那一轮不是孤儿,证一还掉才该收尸(第 1 轮审查问题 2);
//  ㉓ **失去所有权的等待者不起回合** → 作废的那一笔在释放点上就地让出,不送、不清、不落终态(问题 1);
//  ㉔ **失败收尾没有无身份兜底** → 两种身份各自可核,说不清自己是哪一次就一个字都不写(第 2 轮审查问题 1);
//  ㉕ **准备责任是持久的** → 重启后「死在准备」照补投走,不按孤儿收尸(第 2 轮审查问题 2);
//  ㉖ **孤儿结算按同一份持久责任 CAS** → 读完没人管、下笔前有人接手的,那一笔自己不成立(同上,复现 B);
//  ㉗ **真派审入口公开这一轮的同一笔就带着责任** → 一次普通对账收不走刚公开、还在准备的那一轮(同上,复现 A)。
//
// **投递结果**那一半(「这一份送出去了没有、没送出去是哪一种」,㉘㉙)在
// `test-free-review-dispatch-delivery.ts`:它问的不是「这是哪一次」,台子同一个。
//
// **不碰真 CLI**:投递成功那一刻会真走到 `continueTask`,而起真执行器由测试隔离闸拦着
// (`ASH_ALLOW_REAL_AGENT` 没设 = 直接判 turn_failed)。
//
// 跑：npm -w server run test:free-review-dispatch-ownership
import assert from "node:assert/strict";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { root, startHarness } from "./free-review-dispatch-harness.js";
import { releaseTmpDb } from "./tmp-db.js";

try {
  // 台子(临时库、桩、种子数据、夹具)都在 `free-review-dispatch-harness.ts`。
  const {
    db, freeReviewRounds, freeReviewRuns, regressionEvidence, tasks,
    handleFreeWorkflowSettlement,
    claimReviewDispatch, clearReviewDispatchIntent, dispatchReviewRound, preparingReviewDispatch,
    releaseReviewDispatchClaim, reviewDispatchArmed, reviewDispatchOwned, supersedeReviewDispatch,
    failReviewStart, redeliverReviewRound, reopenFailedFreeReview, reviewOrphanStillUnowned,
    reconcileFreeReviews, claimTurn, forceReleaseTurn, freeReviewEvidenceDir, launchReviewRound,
    turnIdentity,
    completeRegressionSettlement, regressionSettlementConclusion,
    at, timeline, until, armedTask, runOf, runRow, roundOf, reviewerSessions, holdLifecycle,
    restarted, finish,
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
    // **光换个代次也抢不走**。这里原先写的是「换了代次就直接接管」,而那正是第 1 轮审查问题 1
    // 的缺口:「不同代次」不等于「更新的代次」—— 旧那一次从长 await 里回来照样能把新一代挤掉。
    assert.equal(claimReviewDispatch(runId, 1, g2), null, "光换个代次，抢不走别人正办着的这一轮");
    assert.equal(supersedeReviewDispatch(runId, 1, g2), false, "更撕不动别人那一代的证");
    // 接管只有一条**有权威依据**的出路:送上一代退场的人(重跑那一笔刚把证据行换成新代次,所以
    // 「上一代是谁」在它手里是事实)定向撤销它那一张,再同步抢自己这一张。
    assert.equal(supersedeReviewDispatch(runId, 1, g1), true, "撤的就是上一代那一张");
    const t2 = claimReviewDispatch(runId, 1, g2);
    assert.ok(t2, "撤完才轮到新一次领证");
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
      verdict = await redeliverReviewRound(task.id, run, round);
    } finally {
      delete (patched as Partial<typeof patched>).select;
    }

    assert.equal(verdict, "hold", "一次瞬时读库故障不该把这一轮打成失败");
    assert.equal(reviewDispatchArmed(runId, 1), false, "认领证必须还回去");
    assert.ok((await roundOf(runId)).dispatch, "没消费的意图原样留着");
    assert.equal((await roundOf(runId)).status, "reviewing", "一个终态都别写");
    assert.equal((await runRow(runId)).status, "reviewing", "run 也别动");
    // 数据库已经健康了,下一拍照样补办得了 —— 这才是「异常之后还能自愈」的判据。
    assert.equal(await redeliverReviewRound(task.id, await runRow(runId), await roundOf(runId)), "handled",
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

  // ── ㉑ 旧那一次挤不掉新一次的认领 ───────────────────────────────────────────
  // 第 1 轮审查问题 1 的第一步。⑳ 钉的是**库**那一半(权威 CAS 拒掉旧意图),可那一步之前旧的
  // 那一次已经先把内存认领挤掉了 —— 它随后按自己刚抢来的 token 归还,删掉的正是它覆盖后的那
  // 一项。于是新一代从此「没人盯着」,而它原先排的等待者还活着:对账见「有意图、没人盯着」就
  // 再排一份,同一轮审查被交付两次(实测 invocations 由 1 增到 3,审查者刚提问还没等到答复)。
  {
    const id = "free-dispatch-claim-authority";
    const runId = await restarted(id, 1);
    const directory = freeReviewEvidenceDir(id, runId, 1);
    const stale = (await roundOf(runId)).dispatch!.generation!;
    const fresh = `${stale}-reopened`;
    // 现场:这一轮已经被重跑成另一次(证据行换了代次),新一次正办着它 —— 认领证在它手里。
    await db.update(regressionEvidence).set({ generation: fresh })
      .where(eq(regressionEvidence.directory, directory));
    await db.update(freeReviewRounds).set({ dispatch: { attempts: 1, since: at, generation: fresh } })
      .where(eq(freeReviewRounds.id, `${runId}-round`));
    const mine = claimReviewDispatch(runId, 1, fresh);
    assert.ok(mine, "新一次先领到证");

    const outcome = await dispatchReviewRound({
      taskId: id, run: { id: runId, currentRound: 1 }, label: "自由工作流第 1 轮",
      message: "上一次重跑的任务书", generation: stale,
      opts: {} as never,
      onFail: async () => assert.fail("过期的那一次不该走到落终态"),
    });

    assert.equal(outcome, "handed-off", "过期的那一次只能让出");
    assert.equal(reviewDispatchOwned(runId, 1, mine!), true,
      "**新一次的认领证必须原样还在它手里** —— 被挤掉再被旧 token 归还,就是那条重复交付的入口");
    assert.equal((await roundOf(runId)).dispatch?.generation, fresh, "意图也不许被它覆盖");
    assert.equal(await reviewerSessions(id), 0, "更不许把上一次的任务书送出去");
    releaseReviewDispatchClaim(runId, 1, mine!);
    console.log("✓ ㉑ 旧那一次挤不掉新一次的认领：内存那一半也有权威");
  }

  // ── ㉒ 准备阶段就有人负责：任务书还在算的那一轮不是孤儿 ─────────────────────
  // 第 1 轮审查问题 2:`launchReviewRound` 要走证据行、工作区、HEAD、MCP 预检、任务书重算一长
  // 串 await,而 run/round 在它之前就已经是 reviewing。那段时间里对账看到的正是「reviewing +
  // 没有意图 + 没有等待者」= 孤儿的全部特征,于是把一个**活着的准备**收尸成 failed/error ——
  // 准备完成后 dispatched=false,这一轮再也不会自动开始。
  //
  // 第 2 轮审查把责任又往前挪了一步:**登记责任的人是公开这一轮的那一个**,而且登记的那一份是
  // **持久的**(round 行上的 `preparing` 意图,与公开 reviewing 同一笔写)。所以这条用例按
  // publisher 的样子布置现场(证 + 持久意图),再让真 launch 卡在准备里。卡住的办法不碰任何库
  // 函数:把 PATH 上那个 codex 桩改慢 —— ash MCP 预检那一步会真的 spawn 它。
  {
    const id = "free-dispatch-preparing-live";
    const runId = await restarted(id, 1);
    const generation = (await roundOf(runId)).dispatch!.generation!;
    // publisher 登记责任的那两下:同步领证 + 公开 reviewing 的同一笔里带上持久意图。
    await db.update(freeReviewRounds)
      .set({ dispatch: preparingReviewDispatch(generation, at, { retry: false, freshSession: true }) })
      .where(eq(freeReviewRounds.id, `${runId}-round`));
    const claimToken = claimReviewDispatch(runId, 1, generation);
    assert.ok(claimToken, "公开这一轮之前就领到了证");
    const stub = join(root, "bin", "codex");
    writeFileSync(stub, "#!/bin/sh\nsleep 0.6\nexit 1\n");
    chmodSync(stub, 0o755);
    try {
      const launching = launchReviewRound(
        (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!, await runRow(runId),
        { responsibility: { generation, claimToken: claimToken!, since: at } });
      await until("launch 真的进了准备阶段", async () => !!(await roundOf(runId)).dispatch);
      assert.equal((await roundOf(runId)).dispatch?.phase, "preparing",
        "持久那一半:库里这一行自己就说得出「有人在准备」（重启后唯一的线索）");
      assert.equal(reviewDispatchArmed(runId, 1), true, "内存那一半:本进程此刻确实有人盯着");
      assert.equal(await reviewOrphanStillUnowned(await runRow(runId)), null,
        "它明明在干活:判据给出凭据就等于放行收尸");
      // 内存那一半单独成立(意图没落库时)由下面的乙钉 —— 这里抹掉它会把第一次排队的 CAS 对象
      // 也一起抹了,后面那句「准备走完就该真排出去」会因此变成假红。
      await reconcileFreeReviews(id);
      assert.equal((await roundOf(runId)).status, "reviewing", "活着的准备不许被收尸（问题 2）");
      assert.equal((await runRow(runId)).status, "reviewing", "run 也不许被它改掉");
      // 这一笔真派出去了(派发层接手之后才还证):它随后在沙箱里起不了真执行器而失败,那是另一
      // 件事 —— 这条用例到此为止,只要它**不是**被当成「已经有在途派发」而让出。
      assert.equal((await launching).dispatched, true, "准备走完就该真排出去");
    } finally {
      writeFileSync(stub, "#!/bin/sh\nexit 1\n");
      chmodSync(stub, 0o755);
    }
  }

  // 乙:反面那一半 —— 准备那一次崩了/让出了(证还回去、意图也没落下),这一轮才真的没人管,
  // 对账照常收尸。没有它,甲那几句就分不清「判据起作用」和「这条路压根收不了尸」。
  {
    const id = "free-dispatch-preparing";
    const runId = await restarted(id, 1);
    const generation = (await roundOf(runId)).dispatch!.generation!;
    await db.update(freeReviewRounds).set({ dispatch: null })
      .where(eq(freeReviewRounds.id, `${runId}-round`));
    const token = claimReviewDispatch(runId, 1, generation);
    assert.ok(token, "准备阶段领得到证");
    assert.equal(reviewDispatchArmed(runId, 1), true, "准备中也算「有人负责」");
    assert.equal(await reviewOrphanStillUnowned(await runRow(runId)), null, "有人准备着就不是孤儿");

    releaseReviewDispatchClaim(runId, 1, token!);
    await reconcileFreeReviews(id);
    assert.equal((await roundOf(runId)).status, "error", "证一还掉就该照常收尸，否则上面那几句是空测");
    console.log("✓ ㉒ 准备阶段就有人负责：活着的准备不被收尸，证还掉才收");
  }

  // ── ㉓ 失去所有权的等待者，在释放点上就地让出 ───────────────────────────────
  // 第 1 轮审查问题 1 的最后一步:回合锁只回答「此刻谁能跑一轮」,它不认识派发 —— 于是过期的
  // 那一笔照样能在释放点上抢到锁,把一份作废的任务书送进会话(审查者那边刚提了问题还没等到
  // 答复,第二份任务书又开了一条新会话)。所以投递前要过一道所有权闸:不是我的就就地让出,
  // 不送、不清意图、也不落终态。
  {
    const id = "free-dispatch-waiter-ownership";
    const runId = await restarted(id, 1);
    const directory = freeReviewEvidenceDir(id, runId, 1);
    const task = (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
    const round = await roundOf(runId);
    const stale = round.dispatch!.generation!;
    // 先占住这个任务的回合:补投只能排进等待队列,等释放点。
    assert.equal(claimTurn(id, "single"), true, "先占住回合");
    assert.equal(await redeliverReviewRound(task.id, await runRow(runId), round), "handled",
      "补投把这一笔排进了等待队列");
    assert.equal(reviewDispatchArmed(runId, 1), true, "排着的那一笔有人负责");

    // 排队期间这一轮被重跑成另一次:定向撤销它那一张、换代次、新一次领证。
    assert.equal(supersedeReviewDispatch(runId, 1, stale), true, "重跑撕掉上一次那一张");
    await db.update(regressionEvidence).set({ generation: `${stale}-reopened` })
      .where(eq(regressionEvidence.directory, directory));
    const mine = claimReviewDispatch(runId, 1, `${stale}-reopened`);
    assert.ok(mine, "新一次领到证");

    // 放锁 —— 等待者被放走,它这一拍必须自己让出。
    forceReleaseTurn({ taskId: id, seq: turnIdentity(id)!.seq });
    for (let i = 0; i < 40; i++) await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(await reviewerSessions(id), 0,
      "**一个字都不许送出去** —— 送了就是同一轮被交付两次（问题 1 的用户现场）");
    assert.ok((await roundOf(runId)).dispatch, "让出不清意图：那份意图现在归新一次");
    assert.equal((await roundOf(runId)).status, "reviewing", "更不许落终态 —— 打死的会是现任那一次");
    assert.equal((await runRow(runId)).status, "reviewing");
    assert.equal(reviewDispatchOwned(runId, 1, mine!), true, "现任的证也不许被让出那一下撕掉");
    releaseReviewDispatchClaim(runId, 1, mine!);
    console.log("✓ ㉓ 失去所有权的等待者在释放点上就地让出：不送、不清、不落终态");
  }

  // ── ㉔ 失败收尾没有无身份兜底 ───────────────────────────────────────────────
  // 第 2 轮审查问题 1:三处 catch(升轮、重跑、即时派审)挂的都是**异步**准备链,异常可以在这一轮
  // 已经失败、被重跑成另一次之后才到。它们原先都省掉身份,于是那一笔绕过代次闸把**现任**打成
  // error,还按整轮(run 级)把新一代刚挂上的哨兵停掉(实测:新审查者仍在输出,它等的后台检查被
  // 停)。必填只解决「写不出省略形」,还要让剩下的两种形状各自**可核** —— 否则「没公开过」就是
  // 换个名字的兜底。
  {
    const id = "free-dispatch-fail-identity";
    const runId = await restarted(id, 1);
    const run = await runRow(runId);
    const directory = freeReviewEvidenceDir(id, runId, 1);
    const generation = (await roundOf(runId)).dispatch!.generation!;

    // 甲:`"unpublished"` 的闸是「轮次行**真的不存在**」。行在那里就说明它已经被公开过(很可能
    // 还被重跑成了另一次),这一笔没有资格碰它 —— 报告里那条路正是从这儿走通的。
    await failReviewStart(run, "旧准备的迟到异常", "unpublished");
    assert.equal((await roundOf(runId)).status, "reviewing",
      "公开过的轮次不许被「没公开过」那一笔改写 —— 打死的会是现任那一次");
    assert.equal((await runRow(runId)).status, "reviewing", "run 也不许");
    assert.doesNotMatch(timeline(id), /审查启动失败/, "连一句话都不该留下");

    // 乙:带身份的那一笔,代次**读不出来**也不放行。原先这里写的是「证据行不在就只看形状」,
    // 而那一档恰恰是无身份兜底的最后一个入口:说不清自己是哪一次,就没有落账的资格。
    await db.delete(regressionEvidence).where(eq(regressionEvidence.directory, directory));
    await failReviewStart(run, "代次读不出来的失败", { generation });
    assert.equal((await roundOf(runId)).status, "reviewing", "读不出代次就一个字都不写");
    assert.equal((await runRow(runId)).status, "reviewing", "run 也不许");
    console.log("✓ ㉔ 失败收尾没有无身份兜底：两种身份各自可核，说不清是哪一次就不落账");
  }

  // ── ㉕ 准备责任是持久的：重启后「死在准备」照补投走 ─────────────────────────
  // 内存那张证只答得出「**本进程**此刻有没有人在办」,进程一没就什么都不剩。所以责任还有持久的
  // 一半:公开 reviewing 的同一笔里落下 `attempts: 0` 的准备意图。有它,「死在准备」和「死在
  // 排队」在恢复眼里就是同一回事 —— 照补投重走一遍,而不是按孤儿收尸。
  {
    const id = "free-dispatch-preparing-restart";
    const runId = await restarted(id, 0, { phase: "preparing" });
    const task = (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
    const run = await runRow(runId);
    assert.equal(reviewDispatchArmed(runId, 1), false, "重启后内存里一个人都没有");
    assert.equal(await reviewOrphanStillUnowned(run), null,
      "库里那一行自己就说得出「有人负责」—— 重启之后这是唯一的线索");

    // 先占住回合,好让补投只排进等待队列(真投递会去起执行器,那是另一件事)。
    assert.equal(claimTurn(id, "single"), true, "先占住回合");
    assert.equal(await redeliverReviewRound(task.id, run, await roundOf(runId)), "handled",
      "「死在准备」归补投管,不归收尸管");
    assert.equal((await roundOf(runId)).status, "reviewing", "一个终态都不许落");
    assert.match(timeline(id), /还在准备阶段/,
      "措辞得说得出上次中断在哪一段 —— 「已尝试 0 次」会让用户以为计数坏了");
    forceReleaseTurn({ taskId: id, seq: turnIdentity(id)!.seq });
    console.log("✓ ㉕ 准备责任是持久的：重启后照补投走，不按孤儿收尸");
  }

  // ── ㉖ 孤儿结算按同一份持久责任 CAS ─────────────────────────────────────────
  // 第 2 轮审查问题 2 复现 B(零故障注入):⑰ 那几问读完之后,到落笔之间还隔着几次 await,而这中间
  // 一次**合法的接手**压根不起回合 —— 公开 reviewing 的那一笔带着持久责任落库,重跑也只是换代次
  // 再登记一次。两者都不增长 `directionEpoch`,所以 ⑱ 那道闸答的是另一个问题,放行它。硬保证只能
  // 是:把「此刻没有任何派发责任」这句前提本身写进落笔那个事务。
  {
    const id = "free-dispatch-orphan-cas";
    const runId = await restarted(id, 1);
    const generation = (await roundOf(runId)).dispatch!.generation!;
    await db.update(freeReviewRounds).set({ dispatch: null })
      .where(eq(freeReviewRounds.id, `${runId}-round`));
    const run = await runRow(runId);
    const fence = await reviewOrphanStillUnowned(run);
    assert.ok(fence, "判断那一刻确实没人管");

    // 这就是那一次接手:它不起回合,所以 `directionEpoch` 一位都没动。
    await db.update(freeReviewRounds)
      .set({ dispatch: preparingReviewDispatch(generation, at, { retry: false, freshSession: true }) })
      .where(eq(freeReviewRounds.id, `${runId}-round`));
    await handleFreeWorkflowSettlement(id, "done", false, null, "reviewer", true, false, fence!);
    assert.equal((await runRow(runId)).status, "reviewing", "迟到的收尾一个字都不许写");
    assert.equal((await roundOf(runId)).status, "reviewing", "轮次也不许被它改掉");
    // 两段式结算:上半场那一笔(settlement/continuation)也得被同一个条件挡住,否则那条正在准备
    // 的审查随后上报结论会被「本轮已进入结算」拒掉(第 4 轮审查 F1 的形状)。
    const poisoned = (await db.select().from(regressionEvidence)
      .where(eq(regressionEvidence.directory, freeReviewEvidenceDir(id, runId, 1)))).at(0)!;
    assert.equal(poisoned.settlement, null, "连首次持久写都不许落");
    assert.equal(poisoned.continuation?.phase, "running", "续跑相位也不许被它改成 exited");

    // 没人接手时,同一条路照常把它收掉 —— 闸挡的是迟到者,不是收尾本身。
    await db.update(freeReviewRounds).set({ dispatch: null })
      .where(eq(freeReviewRounds.id, `${runId}-round`));
    const again = await reviewOrphanStillUnowned(run);
    assert.ok(again, "这一拍仍然没人管");
    await handleFreeWorkflowSettlement(id, "done", false, null, "reviewer", true, false, again!);
    assert.equal((await runRow(runId)).status, "failed", "没人接手时照常收尾");
    console.log("✓ ㉖ 孤儿结算按同一份持久责任 CAS：下笔前有人接手的，那一笔自己不成立");
  }

  // ── ㉗ 真派审入口：公开这一轮的同一笔就带着责任 ─────────────────────────────
  // 第 2 轮审查问题 2 复现 A(零故障注入):`startFreeReview` 先插 run、再插 round,然后还要清预约、
  // 可选写时间线,最后才调 launch。那几步之间 run/round 都已经是 reviewing,而责任一处也没有 ——
  // 一次普通对账就把它判成 failed/error,随后 POST 照样回 201,任务书一个字都没送出去。
  //
  // 前面几条用例的现场都是手工摆的,钉不住「**生产那三个 publisher** 到底有没有在公开的同一笔里
  // 登记责任」。这一条走真入口:预约消费 → startFreeReview → 公开 → launch。卡住的办法还是那个
  // 慢桩(MCP 预检会真 spawn 它),所以观察窗口落在「已经公开、还在准备」上。
  {
    const id = "free-dispatch-publish-atomic";
    await armedTask(id);
    const stub = join(root, "bin", "codex");
    writeFileSync(stub, "#!/bin/sh\nsleep 0.8\nexit 1\n");
    chmodSync(stub, 0o755);
    try {
      const settling = handleFreeWorkflowSettlement(id, "done", true, true, "single");
      await until("派审真的把这一轮公开了", async () => !!(await runOf(id)));
      const run = await runOf(id);
      await until("round 行也落下来了", async () => !!(await roundOf(run.id)));
      const round = await roundOf(run.id);
      assert.equal(round.status, "reviewing", "这一刻它确实已经公开了（用户那边能看到「审查中」）");
      assert.ok(round.dispatch, "**公开的同一笔就带着责任** —— 复现 A 就是从这个缺口进来的");
      assert.equal(round.dispatch?.phase, "preparing", "而且说得出它此刻还在准备阶段");
      assert.equal(await reviewOrphanStillUnowned(run), null, "所以孤儿路一个字都不许写");
      await reconcileFreeReviews(id);
      assert.equal((await roundOf(run.id)).status, "reviewing", "一次普通对账收不走它（复现 A）");
      assert.equal((await runRow(run.id)).status, "reviewing", "run 也不许被它改掉");
      await settling;
      assert.equal((await roundOf(run.id)).dispatch?.phase, "queued", "准备走完,相位往前走一格");
      // 回合是 armedTask 刻意占着的(复刻结算钩子跑在锁里那一刻);放开它,这一笔才有结局,
      // 认领证也才还得回来 —— `finish` 那一扫等的就是它。
      forceReleaseTurn({ taskId: id, seq: turnIdentity(id)!.seq });
    } finally {
      writeFileSync(stub, "#!/bin/sh\nexit 1\n");
      chmodSync(stub, 0o755);
    }
    console.log("✓ ㉗ 真派审入口：公开这一轮的同一笔就带着责任，对账收不走还在准备的那一轮");
  }


  await finish(["free-dispatch-generation", "free-dispatch-reopen", "free-dispatch-claim-leak",
    "free-dispatch-settle-guard", "free-dispatch-fence", "free-dispatch-lifecycle",
    "free-dispatch-fence-commit", "free-dispatch-lifecycle-late", "free-dispatch-lifecycle-reopen",
    "free-dispatch-authority", "free-dispatch-claim-authority", "free-dispatch-preparing-live",
    "free-dispatch-preparing", "free-dispatch-waiter-ownership", "free-dispatch-fail-identity",
    "free-dispatch-preparing-restart", "free-dispatch-orphan-cas", "free-dispatch-publish-atomic"],
    ["free-dispatch-reopen", "free-dispatch-claim-leak", "free-dispatch-lifecycle-reopen",
      "free-dispatch-preparing-live", "free-dispatch-preparing-restart",
      "free-dispatch-publish-atomic"]);
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
