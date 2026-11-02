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
//  D2 审查派发 · 说不清:认领证还回来(不卡在「本进程还盯着」),意图不被宣布送到,对账按交付
//     凭据裁决 —— 不重投第二份任务书;
//  D3 审查派发 · 拒收:认领证还回来,这一轮不停在 reviewing,也不重投第二份任务书。
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
    until, runOf, roundOf, reviewerSessions, freeTask, armedTask, finish,
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
  for (const [label, acceptance] of [["D2", "unknown"], ["D3", "refused"]] as const) {
    const id = `verdict-dispatch-${acceptance}`;
    stage = { acceptance: acceptance === "unknown" ? deferred<InputAcceptance>().promise : Promise.resolve("refused") };
    const run = await dispatch(id);
    await until("这一轮收尾", () => turnOver(id));
    await until("认领证还回来", () => !reviewDispatchArmed(run.id, 1));
    // 对账接手:交付凭据(spawn 之后落下)说这一份已经送过,只能结清、不许再投一份。
    await reconcileFreeReviews(id);
    await sleep(200);
    assert.equal(await reviewerSessions(id), 1, "送没送到说不清 / 被拒收,都不许自动再投第二份任务书");
    assert.notEqual((await roundOf(run.id)).status === "reviewing" && (await roundOf(run.id)).dispatch != null
      && reviewDispatchArmed(run.id, 1), true, "不许卡在「有意图 + 本进程还盯着」");
    console.log(`✓ ${label} 审查派发 · ${acceptance === "unknown" ? "说不清" : "拒收"}:认领证归还、不重投,交给持久凭据裁决`);
  }

  await finish(["verdict-dispatch-accepted", "verdict-dispatch-unknown", "verdict-dispatch-refused"]);
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
