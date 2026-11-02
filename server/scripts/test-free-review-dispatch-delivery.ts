// 审查派发的**投递那一侧**:这一份任务书到底送出去了没有,没送出去又是哪一种。
//
// 跟隔壁两份的分工(台子是同一个,`free-review-dispatch-harness.ts`):
//  · `test-free-review-dispatch-retry.ts` —— **重排本体**:输一次不落终态、连输到界、跨重启补办;
//  · `test-free-review-dispatch-ownership.ts` —— **身份那一半**:同一个 round 行先后代表同一轮
//    的好几次派发(用户重跑),认领 / 意图 / 资源处置 / 失败收尾 / 孤儿收尾各自分得清是哪一次;
//  · 这一份 —— **结果那一半**:投递有没有真的发生、以及「没发生」要分成几种。两条用例一条管
//    一个方向,合在一起才是「同一份任务书只送一次,而一次瞬时争用不算送不出去」。
//
// 为什么单独一份:这两条原先住在 ownership 里,把那个文件顶到 728 行、越过仓库的 700 行上限
// (第 2 轮审查的唯一阻塞)。切口按**测试职责**走而不是按行数凑 —— 它们问的压根不是「这是哪
// 一次」,而是「这一次的投递结果是什么」。编号接着整套往下排(retry ①–⑬、ownership ⑭–㉗),
// 所以这里从 ㉘ 起。
//
// **不碰真 CLI**:投递成功那一刻会真走到 `continueTask`,而起真执行器由测试隔离闸拦着
// (`ASH_ALLOW_REAL_AGENT` 没设 = 直接判 turn_failed)。
//
// 跑：npm -w server run test:free-review-dispatch-delivery
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { root, startHarness } from "./free-review-dispatch-harness.js";
import { releaseTmpDb } from "./tmp-db.js";

try {
  // 台子(临时库、桩、种子数据、夹具)都在 `free-review-dispatch-harness.ts`。
  const {
    db, freeReviewRounds, regressionEvidence, tasks,
    dispatchReviewRound, redeliverReviewRound, reviewDispatchArmed,
    claimOwnTurn, continueWhenIdle, forceReleaseTurn, freeReviewEvidenceDir, releaseTurn,
    turnIdentity,
    at, until, freeTask, runRow, roundOf, reviewerSessions, restarted, finish,
  } = await startHarness();

  // ── ㉘ 交付凭据是权威:已经送到的那一份不许再排一次 ───────────────────────────
  // 第 1 轮审查问题 1:清意图那一笔**失败**时(`settled` 刻意不因此卡住,见那里的注释),库里那份
  // **已经交付过**的意图原样留着。于是一份慢恢复的次数 CAS 会从 2 正常地走到 3 —— 它根本不会
  // 输,接着就对一条**审查者已经读过**的任务书再排一份完整的(实测:两条 reviewer 会话、两次壳
  // 桩调用,第一份审查登记的问题还没等到答复)。次数证不了「这一份没送过」,凭据才是权威。
  //
  // 两道都要钉,顺序是**先钉落库那一笔**:只测早筛的话,把 WHERE 里那一条删掉照样全绿 ——
  // 而幂等恰恰只能由那一笔自己担保(早筛问完到下笔之间隔着工作区、MCP 预检、任务书重算)。
  {
    const id = "free-dispatch-receipt";
    const runId = await restarted(id, 2);
    const directory = freeReviewEvidenceDir(id, runId, 1);
    const generation = (await roundOf(runId)).dispatch!.generation!;
    const evidence = (await db.select().from(regressionEvidence)
      .where(eq(regressionEvidence.directory, directory))).at(0)!;
    // 正常投递流程落下的那份凭据(`commitReviewTurnDelivery` 紧挨着 spawn 之后写的那一笔):
    // 目录 + 代次 + 这一轮的目标身份。
    await db.update(tasks).set({ waitOwnership: { deliveredReview: {
      directory, generation, identity: evidence.targetIdentity!, confirmedAt: at,
    } } }).where(eq(tasks.id, id));

    // ① **落库那一笔**:身份、代次、版本全对,只差「这一份已经送过了」——它就该输在 WHERE 上。
    const outcome = await dispatchReviewRound({
      taskId: id, run: { id: runId, currentRound: 1 }, label: "自由工作流第 1 轮",
      message: "已经送达过的任务书", generation, attempts: 2, since: at,
      opts: {} as never,
      onFail: async () => assert.fail("送到过的那一份只能让出，不该落终态"),
    });
    assert.equal(outcome, "handed-off", "已经交付过的那一份只能让出");
    assert.equal((await roundOf(runId)).dispatch?.attempts, 2,
      "**次数一位都不许往前走** —— 它正常 CAS 到 3 就是那条重复交付的入口");
    assert.equal(await reviewerSessions(id), 0, "更不许把同一份任务书送第二遍");
    assert.equal(reviewDispatchArmed(runId, 1), false, "让出的时候认领证要还回去");

    // ② **早筛**:补投那一侧现读凭据,结清意图、不重投。它只收 taskId —— 调用方那份 task 快照
    //    是好几次 await 之前读的,签名收窄之后拿它授权这件事**类型上就办不到**了。
    assert.equal(await redeliverReviewRound(id, await runRow(runId), await roundOf(runId)), "hold",
      "送到过的这一轮既不该补投,也不该就地收尸(它此刻很可能正跑着)");
    assert.equal((await roundOf(runId)).dispatch, null, "那份没清掉的意图由这一次结清");
    assert.equal(await reviewerSessions(id), 0, "还是一个字都没送出去");
    console.log("✓ ㉘ 交付凭据是权威：已经送到的那一份既不许重排，也不许被次数 CAS 放过");
  }

  // ── ㉙ 内层抢占是瞬时的:确证没送出去的那一种要重排 ──────────────────────────
  // 第 1 轮审查问题 2:外层在释放点上占到了锁,**交接到内层之间**还隔着所有权闸、冻结复查、
  // 起跑预检 —— 这把锁完全可以在那期间被合法放开(人工 reclaim / 幽灵锁巡检)、另一回合占上。
  // 内层 `reclaimTurn` 拒绝接管恰恰是对的,但它返回的 null 过去被压成一个光秃秃的 false,再被
  // 压成 `not-delivered` —— 实测:POST 仍回 201,而这一轮 run=failed / round=error,只尝试过
  // 1 次,时间线写的是「回合被其它执行抢占，消息未能投递」却再也不会重排。
  //
  // 这里不伪造 `continueTask` 的返回值:用真的 `forceReleaseTurn`(人工放开与幽灵巡检走的同一
  // 条路)按快照 seq 放掉外层那一把,再用真的 `claimOwnTurn` 让竞争者占上。注入点是所有权闸,
  // 因为生产里那几个 await 正落在同一个位置。
  {
    const id = "free-dispatch-inner-preempt";
    await freeTask(id);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, id));
    const seen: Array<{ failure: string; message: string }> = [];
    let rival: ReturnType<typeof claimOwnTurn> = null;
    continueWhenIdle(id, "这一轮的任务书", { system: "run", sideTurn: true },
      (message, failure) => { seen.push({ failure, message }); },
      () => assert.fail("锁已经不在手上了，一个字都不该送出去"),
      async () => {
        // 外层此刻已经占到锁(排到队头那一瞬同步占的)。放掉它,让另一回合合法占上。
        const outer = turnIdentity(id)!;
        assert.ok(forceReleaseTurn({ taskId: id, seq: outer.seq }), "放开的得是外层那一把");
        rival = claimOwnTurn(id, "single");
        assert.ok(rival, "竞争者必须真占上，否则这条用例压根没复现");
        return null;    // 所有权没换人:换的只是回合锁那一把
      });
    await until("这一笔投递有了结局", () => seen.length > 0);
    assert.equal(seen[0]!.failure, "turn-taken",
      "**锁被别的执行接走是瞬时的**：压成 not-delivered 就等于一次合法的锁交替打死一轮审查");
    assert.equal(await reviewerSessions(id), 0, "确证没送出去：一条会话都不许起");
    releaseTurn(id, rival!);

    // 反向也要钉住:**不是所有 false 都该重排**。唤醒资格不成立是退避,重排只会原地再撞一遍
    // 同一个拒绝理由 —— 它必须照旧按 `not-delivered` 上报,而不是蹭上瞬时那一档。
    const backoff: string[] = [];
    continueWhenIdle(id, "这一轮的任务书", {
      system: "run", sideTurn: true, wakeGuard: async () => "这个任务此刻不该被叫醒",
    }, (_message, failure) => { backoff.push(failure); }, () => assert.fail("退避也不该送出去"));
    await until("退避那一笔也有了结局", () => backoff.length > 0);
    assert.equal(backoff[0], "not-delivered", "退避不许蹭上「瞬时、可重排」那一档");
    console.log("✓ ㉙ 内层抢占是瞬时的：确证没送出去的那一种要重排，退避照旧落终态");
  }

  await finish(["free-dispatch-receipt", "free-dispatch-inner-preempt"], []);
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
