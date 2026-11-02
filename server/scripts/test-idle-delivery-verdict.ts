// `continueWhenIdle` 交接成功之后的**三档裁决**:收下 / 拒收 / 说不清,各走各的出口。
//
// 为什么要有这一份:这一层从前只有一个 `onDelivered`,而且「整轮返回还没叫过就兜底再叫一次」——
// 那正是上游把 `continueTask` 的回调改名成三态 `onInputSettled` 要杀的歧义(把「回调被调到」读成
// 「已送达」)。两条分支合并之后,这一层留在旧契约上:编译红,而且一旦把旧名字加回去,协议层
// 明确拒收的那一轮会被兜底「按已投递了结」,派审那一侧据此清掉在途意图。
//
// 执行器换成一个**由用例控制回执**的桩(和 review-delivery-worker.ts 同一种接法):测试隔离闸给的
// 是一个起不来的子进程,codex 那一侧据此答 `refused`,摆不出「收下」与「说不清」两种现场。
//
//  V1 收下:回执一落定就报,**不等这一轮跑完**;调用方自己的记账先走,它抛了也不拦裁决;
//  V2 拒收:**这一轮结束之后**才报,措辞说得出「可以放心重投」;从不报收下;
//  V3 说不清 → 迟到的收下:先报说不清(不报收下、不报拒收),迟到的凭据落定成收下再补报;
//  V4 说不清 → 迟到的拒收:同上,补报拒收;
//  V5 压根没交接回执(spawn 之前就失败):报说不清 —— 不许再被兜底成「送到了」;
//  D1 审查派发 · 收下:意图在这一轮跑完之前就了结、认领证还回来;
//  D2 审查派发 · 说不清:回合结束时**按住不结**(第 1 轮自由审查 R1:结算从前只问「有没有结论」,
//     当场结成「未能正常给出结论」,意图晾在终态轮次上);认领证还回来,对账按交付凭据只结清
//     意图、不重投,下一拍照实结算;
//  D3 审查派发 · 拒收:结算当场收尾,时间线写明拒收;不停在 reviewing,也不重投;
//  D4/D5 审查派发 · 说不清 → 迟到的收下 / 拒收:按住期间定论到了 —— 收下只了结意图、对账照常
//     结算;拒收带着真实原因落终态(从前那一轮已被结掉,这一声被挡回去)。
//
// 跑：npm -w server run test:idle-delivery-verdict
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { InputAcceptance, RunHandle, RunOpts } from "../src/executors/types.js";
import { root, startHarness } from "./free-review-dispatch-harness.js";
import { releaseTmpDb } from "./tmp-db.js";

// 初次有界等待压短:说不清那几条要等它超时。回合结束时那「最后一句」的 2 秒照真实口径。
process.env.ASH_TURN_INPUT_ACK_MS = "100";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

/** 下一次起跑该摆成什么样:回执本体、这一轮什么时候收尾、或者干脆在 spawn 之前就抛。 */
type Stage = { acceptance?: Promise<InputAcceptance>; hold?: Promise<void>; throwOnRun?: boolean };
let stage: Stage = {};

try {
  const {
    db, sessions, tasks, handleFreeWorkflowSettlement, reconcileFreeReviews,
    reviewDispatchArmed, continueWhenIdle, releaseTurn, turnIdentity,
    timeline, until, runOf, roundOf, reviewerSessions, freeTask, armedTask, finish,
  } = await startHarness();
  const { CodexExecutor } = await import("../src/executors/codex.js");
  const run = function (_opts: RunOpts): RunHandle {
    const current = stage;
    if (current.throwOnRun) throw new Error("执行器在 spawn 之前就起不来（用例注入）");
    return {
      sessionId: "verdict-stub", commandLine: "verdict stub", kill() {},
      inputAccepted: current.acceptance,
      events: (async function* () {
        await current.hold;
        yield { kind: "done" as const, exitStatus: 0 };
      })(),
    };
  };
  CodexExecutor.prototype.run = run;
  CodexExecutor.prototype.runSteerable = run;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const endedAtOf = async (id: string) =>
    (await db.select().from(sessions).where(eq(sessions.taskId, id))).map((row) => row.endedAt);
  const turnOver = async (id: string) => !turnIdentity(id) && (await endedAtOf(id)).some((endedAt) => !!endedAt);

  /** 一条普通 single 回合上的投递,把三个出口与 onError 各自被叫了什么全记下来。 */
  const deliver = async (id: string, opts: Parameters<typeof continueWhenIdle>[2] = {}) => {
    await freeTask(id);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, id));
    const seen = {
      accepted: [] as Array<Array<string | null>>,
      refused: [] as Array<{ message: string; endedAt: Array<string | null> }>,
      unconfirmed: [] as string[],
      errors: [] as string[],
    };
    continueWhenIdle(id, "一句话", { system: "run", agent: "codex", executorId: "ex", ...opts },
      (message, failure) => { seen.errors.push(`${failure}: ${message}`); },
      {
        onAccepted: async () => { seen.accepted.push(await endedAtOf(id)); },
        onRefused: async (message) => { seen.refused.push({ message, endedAt: await endedAtOf(id) }); },
        onUnconfirmed: (message) => { seen.unconfirmed.push(message); },
      });
    return seen;
  };

  // ── V1 收下:回执一落定就报,不等整轮;调用方记账先走,抛了也不拦 ────────────────
  {
    const id = "verdict-accepted";
    const hold = deferred<void>();
    stage = { acceptance: Promise.resolve("accepted"), hold: hold.promise };
    const accounting: InputAcceptance[] = [];
    const seen = await deliver(id, {
      onInputSettled: (acceptance) => {
        accounting.push(acceptance);
        throw new Error("调用方自己那笔账没记上（用例注入）");
      },
    });
    await until("收下那一声到了", () => seen.accepted.length > 0);
    assert.deepEqual(seen.accepted[0]!.filter((endedAt) => endedAt !== null), [],
      "回执到手的那一刻这一轮还没收尾 —— 等整轮跑完才报,持久意图就要白挂几十分钟");
    assert.deepEqual(accounting, ["accepted"], "调用方自己的三档记账照样被叫到,而且排在裁决之前");
    hold.resolve();
    await until("这一轮收尾", () => turnOver(id));
    await sleep(2_300); // 越过回合结束时那「最后一句」的等待:收下之后不许再冒出别的档
    assert.equal(seen.accepted.length, 1, "收下只报一次");
    assert.deepEqual([seen.refused, seen.unconfirmed, seen.errors], [[], [], []]);
    console.log("✓ V1 收下:回执落定就报、不等整轮;调用方记账抛了也不拦这句协议事实");
  }

  // ── V2 拒收:这一轮结束之后才报,而且从不报收下 ───────────────────────────────
  {
    const id = "verdict-refused";
    const hold = deferred<void>();
    stage = { acceptance: Promise.resolve("refused"), hold: hold.promise };
    const seen = await deliver(id);
    await sleep(300);
    assert.equal(seen.refused.length, 0, "被拒收的那一轮还在收尾,这时就交代会和它自己的结算抢状态");
    hold.resolve();
    await until("拒收那一声到了", () => seen.refused.length > 0);
    assert.ok(seen.refused[0]!.endedAt.some((endedAt) => !!endedAt), "拒收在这一轮收完尾之后才报");
    assert.match(seen.refused[0]!.message, /拒收.*放心重投/, "措辞要说得出「确证没进去、可以重投」");
    await sleep(100);
    assert.deepEqual([seen.accepted, seen.unconfirmed, seen.errors], [[], [], []],
      "**跑完了 ≠ 送到了**:从前这里被兜底「按已投递了结」");
    assert.equal(seen.refused.length, 1);
    console.log("✓ V2 拒收:这一轮结束之后才交代,不被兜底成送到");
  }

  // ── V3/V4 说不清 → 迟到的定论 ───────────────────────────────────────────────
  for (const late of ["accepted", "refused"] as const) {
    const id = `verdict-unknown-${late}`;
    const receipt = deferred<InputAcceptance>();
    stage = { acceptance: receipt.promise };
    const seen = await deliver(id);
    await until("这一轮收尾", () => turnOver(id));
    await until("说不清那一声到了", () => seen.unconfirmed.length > 0);
    assert.deepEqual([seen.accepted, seen.refused, seen.errors], [[], [], []],
      "说不清既不许当送到(了结意图),也不许当没送到(落终态/重排)");
    receipt.resolve(late);
    await until(`迟到的${late}补报`, () => (late === "accepted" ? seen.accepted : seen.refused).length > 0);
    await sleep(100);
    assert.equal(seen.unconfirmed.length, 1, "说不清只报一次");
    assert.equal(seen.accepted.length + seen.refused.length, 1, "定论只报一次,而且只报落定的那一档");
    console.log(`✓ ${late === "accepted" ? "V3" : "V4"} 说不清 → 迟到的${late === "accepted" ? "收下" : "拒收"}:先报说不清,定论落定再补报`);
  }

  // ── V5 压根没交接回执:报说不清,不许兜底成送到 ─────────────────────────────
  {
    const id = "verdict-no-receipt";
    stage = { throwOnRun: true };
    const seen = await deliver(id);
    await until("说不清那一声到了", () => seen.unconfirmed.length > 0);
    await sleep(100);
    assert.deepEqual([seen.accepted, seen.refused], [[], []],
      "整轮返回却没交接过回执 —— 从前这里打一行日志就「按已投递了结」");
    console.log("✓ V5 没走到交接回执:报说不清,不再兜底成「送到了」");
  }

  // ── D 审查派发:三档各自落到哪 ───────────────────────────────────────────────
  /** 结算按预约派审,放掉结算所在那一轮的锁,让审查回合起跑(同 retry 用例①的现场)。 */
  const dispatch = async (id: string) => {
    await armedTask(id);
    await handleFreeWorkflowSettlement(id, "done", true, true, "single");
    const run = await runOf(id);
    assert.equal(reviewDispatchArmed(run.id, 1), true);
    releaseTurn(id, undefined);
    return run;
  };
  {
    const id = "verdict-dispatch-accepted";
    const hold = deferred<void>();
    stage = { acceptance: Promise.resolve("accepted"), hold: hold.promise };
    const run = await dispatch(id);
    await until("审查会话起来了", async () => (await reviewerSessions(id)) > 0);
    await until("意图了结", async () => (await roundOf(run.id)).dispatch == null);
    assert.equal(reviewDispatchArmed(run.id, 1), false, "收下了,认领证就该还回来");
    assert.ok(!(await turnOver(id)), "了结发生在这一轮跑完之前");
    hold.resolve();
    console.log("✓ D1 审查派发 · 收下:意图在这一轮跑完之前了结,认领证归还");
  }
  /** 这一轮审查此刻在库里的样子:轮次状态、在途意图、交付凭据上记着的回执。 */
  const reviewState = async (id: string, runId: string) => {
    const round = await roundOf(runId);
    const task = (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
    return { status: round.status, dispatch: round.dispatch, acceptance: task.waitOwnership?.deliveredReview?.acceptance };
  };
  /** 回合结束、审查者没交卷,而任务书送没送到还说不清:这一轮必须被**按住**,不许当场结成终态。 */
  const assertHeld = async (id: string, runId: string) => {
    const state = await reviewState(id, runId);
    assert.equal(state.acceptance, "unknown", "说不清这件事要落在持久交付凭据上,结算读的就是它");
    assert.equal(state.status, "reviewing",
      "第 1 轮自由审查 R1:结算只问「有没有结论」,把输入说不清的一轮当场结成「未能正常给出结论」");
    assert.notEqual(state.dispatch, null, "按住期间意图还归派发负责,不许被晾在一个终态轮次上");
  };

  // ── D2 说不清,到头也说不清:按住 → 认领证归还 → 对账只结清意图、不重投 → 下一拍照实结算 ──
  {
    const id = "verdict-dispatch-unknown";
    stage = { acceptance: deferred<InputAcceptance>().promise };
    const run = await dispatch(id);
    await until("这一轮收尾", () => turnOver(id));
    await assertHeld(id, run.id);
    await until("认领证还回来", () => !reviewDispatchArmed(run.id, 1));
    await assertHeld(id, run.id);
    await reconcileFreeReviews(id);
    let state = await reviewState(id, run.id);
    assert.deepEqual([state.status, state.dispatch], ["reviewing", null], "交付凭据说越过了线:只结清意图");
    await reconcileFreeReviews(id);
    state = await reviewState(id, run.id);
    assert.notEqual(state.status, "reviewing", "意图已空、没人负责了:下一拍按孤儿结算,不许永远挂着");
    assert.match(timeline(id), /送没送进审查者手里说不清/, "时间线要说真话,不是只剩「未能正常给出结论」");
    assert.equal(await reviewerSessions(id), 1, "说不清时重投就是重复执行");
    console.log("✓ D2 审查派发 · 说不清:回合结束时按住不结,对账结清意图不重投,随后照实结算");
  }

  // ── D4/D5 说不清 → 迟到的定论:按住期间到了,各走各的出口 ───────────────────────
  for (const [label, late] of [["D4", "accepted"], ["D5", "refused"]] as const) {
    const id = `verdict-dispatch-late-${late}`;
    const receipt = deferred<InputAcceptance>();
    stage = { acceptance: receipt.promise };
    const run = await dispatch(id);
    await until("这一轮收尾", () => turnOver(id));
    await assertHeld(id, run.id);
    receipt.resolve(late);
    if (late === "accepted") {
      await until("意图了结", async () => (await reviewState(id, run.id)).dispatch == null);
      const state = await reviewState(id, run.id);
      assert.deepEqual([state.status, state.acceptance], ["reviewing", "accepted"],
        "收下了只了结意图;这一轮的结论由结算给,不由投递层替它下");
      await until("认领证还回来", () => !reviewDispatchArmed(run.id, 1));
      await reconcileFreeReviews(id);
      assert.notEqual((await reviewState(id, run.id)).status, "reviewing", "没人负责了,对账照常结算");
      assert.doesNotMatch(timeline(id), /拒收|说不清/, "确实收下了,就不许冒出「没收到」那类话");
    } else {
      await until("落了终态", async () => (await reviewState(id, run.id)).status !== "reviewing");
      const state = await reviewState(id, run.id);
      assert.deepEqual([state.status, state.dispatch, state.acceptance], ["error", null, "refused"]);
      assert.match(timeline(id), /拒收.*放心重投/,
        "迟到的拒收必须落得下账 —— 从前那一轮早被结掉,这一声被「这一轮已有结论」挡回去");
      await until("认领证还回来", () => !reviewDispatchArmed(run.id, 1));
    }
    assert.equal(await reviewerSessions(id), 1, "不自动再投第二份任务书");
    console.log(`✓ ${label} 审查派发 · 说不清 → 迟到的${late === "accepted" ? "收下:了结意图,对账照常结算" : "拒收:带着真实原因落终态"}`);
  }

  // ── D3 拒收:结算当场照实收尾,不停在 reviewing,也不重投 ─────────────────────────
  {
    const id = "verdict-dispatch-refused";
    stage = { acceptance: Promise.resolve("refused") };
    const run = await dispatch(id);
    await until("这一轮收尾", () => turnOver(id));
    const state = await reviewState(id, run.id);
    assert.equal(state.acceptance, "refused");
    assert.notEqual(state.status, "reviewing", "确证没送进去,用不着等:当场收尾");
    assert.match(timeline(id), /协议层明确拒收，审查者一个字都没收到/, "时间线写的是真实原因");
    await until("认领证还回来", () => !reviewDispatchArmed(run.id, 1));
    await until("意图了结", async () => (await reviewState(id, run.id)).dispatch == null);
    assert.equal(await reviewerSessions(id), 1, "被拒收也不许自动重投 —— 重投的出路是用户重跑这一轮");
    console.log("✓ D3 审查派发 · 拒收:当场照实收尾,时间线写明拒收,不重投");
  }

  await finish(["verdict-dispatch-accepted", "verdict-dispatch-unknown", "verdict-dispatch-late-accepted",
    "verdict-dispatch-late-refused", "verdict-dispatch-refused"]);
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
