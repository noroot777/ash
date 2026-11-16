// 自动开工的那一份账（launch-request.ts）和「同组同时最多四条」（launch-capacity.ts）。重启那一档在
// test-launch-restart.ts（要两个进程）。
//
//  L1 运行一个八条的分组：先起四条，跑完一条补一条；几路放行同时来（重复放行、整扫、运行分组再按一次）
//     任何时刻同组在跑的都不超过四条，八条最后都起了；
//  L2 用户点运行不拦、但算在数里：组里已满四条时手点第五条照起，挂着请求的第六条要等在跑的降到三条才起；
//  L3 审查的旁路回合不算名额；
//  L4 队列推进不拦（同组已满四条，队列里轮到的那条照起）；
//  L5 被名额挡住的那条，页面上说的是「同组已有四条在跑」，不说「在等前置」；不在分组里的说公共那一桶；
//  L6 被名额挡住时点停止：请求撤回，腾出名额、再扫都不会再起它；
//  L7 分组暂停：挂着请求的不起，页面上说被暂停了；「接着跑」之后照请求起；被暂停打断的成员从它自己的会话续跑；
//  L8 团队执行者照样由运行分组起、照样受名额限制。
// L9–L12、N1（出岔子的那几档）在 launch-request-failure-cases.ts；起跑报错的退避、停止冻住正在起跑的那一次，
// 在 checkpoint-group-failure-cases.ts。
// 跑：npm -w server run test:launch-request
import {
  db, hasStarted, inputsOf, project, release, request, row, runs, schema, setup, sleep, started, tasks, teardown, until, view,
} from "./prerequisite-fixture.js";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

const { runGroup, pauseGroup, advanceQueue } = await import("../src/scheduler.js");
const { launchRequestFailureCases } = await import("./launch-request-failure-cases.js");
const { requestLaunch, releaseLaunch, sweepLaunchRequests } = await import("../src/launch-request.js");
const { runningInGroup, PARALLEL_LIMIT } = await import("../src/launch-capacity.js");
const { launchRecord } = await import("../src/prerequisite-store.js");

type Project = Awaited<ReturnType<typeof project>>;

/** 一批不用 worktree 的成员（起得快），都记进 `started` 让收尾放它们走。 */
async function members(p: Project, prefix: string, count: number, opts: { group?: string | null } = {}) {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) ids.push(await p.task(`${prefix}${index}`, { useWorktree: false }));
  if (opts.group !== undefined) for (const id of ids) await db.update(tasks).set({ groupId: opts.group }).where(eq(tasks.id, id));
  started.push(...ids);
  return ids;
}

const { heldTurns } = await import("../src/turn-lock.js");
/** 这几条里此刻占着执行回合的有几条（同步看锁，采样用）。 */
const executing = (ids: readonly string[]) => heldTurns()
  .filter((turn) => ids.includes(turn.taskId) && (turn.role === "single" || turn.role === "duet")).length;

/** 采样「同时在跑」的峰值，直到 stop()。 */
function peak(ids: readonly string[]) {
  let max = 0;
  const timer = setInterval(() => { max = Math.max(max, executing(ids)); }, 5);
  return { stop: () => { clearInterval(timer); max = Math.max(max, executing(ids)); return max; } };
}

const startedOf = (ids: readonly string[]) => ids.filter((id) => hasStarted(id));
const finished = async (id: string) => until(`${id} 跑完`, async () => (await row(id)).status === "done" && !runs.turnIdentity(id));

try {
  await setup();

  // ── L1 八条的分组：先四条，跑完一条补一条，几路放行同时来也不超 ─────────────
  {
    const p = await project();
    const ids = await members(p, "l1-", 8);
    const sample = peak(ids);
    await Promise.all([
      runGroup(p.group),
      runGroup(p.group),
      sweepLaunchRequests(),
      ...ids.map((id) => releaseLaunch(id)),
    ]);
    await until("先起四条", () => startedOf(ids).length === PARALLEL_LIMIT);
    await sleep(400);
    assert.equal(startedOf(ids).length, PARALLEL_LIMIT, "名额满了，其余四条等着");
    assert.equal(await runningInGroup(p.group), PARALLEL_LIMIT);
    for (let done = 1; done <= 4; done++) {
      const running = startedOf(ids).filter((id) => runs.turnIdentity(id));
      release(running[0]!);
      await finished(running[0]!);
      await until(`跑完 ${done} 条补 ${done} 条`, () => startedOf(ids).length === PARALLEL_LIMIT + done);
      await sleep(250);
      assert.equal(startedOf(ids).length, PARALLEL_LIMIT + done, "跑完一条只补一条");
    }
    for (const id of ids) release(id);
    for (const id of ids) await finished(id);
    assert.ok(sample.stop() <= PARALLEL_LIMIT, "任何时刻同组在跑的都不超过四条");
    for (const id of ids) assert.equal((await launchRecord(id))?.requestedAt ?? null, null, `${id} 的请求了结`);
    console.log("PASS L1: a group of eight starts four, backfills one per finish, concurrent releases never exceed four");
  }

  // ── L2 手点运行不拦但算数；L5 页面上那一句 ─────────────────────────────────
  {
    const p = await project();
    const ids = await members(p, "l2-", 6);
    await requestLaunch(ids.slice(0, 4), { source: "group" });
    await sweepLaunchRequests();
    await until("先起四条", () => ids.slice(0, 4).every(hasStarted));
    assert.equal((await request("POST", `/tasks/${ids[4]}/run`)).status, 202, "手点运行不受名额限制");
    await until("手点的第五条起了", () => hasStarted(ids[4]!));
    assert.equal(await runningInGroup(p.group), 5, "手点起的也算在数里");

    await requestLaunch([ids[5]!], { source: "run" });
    await releaseLaunch(ids[5]!);
    await sleep(300);
    assert.equal(hasStarted(ids[5]!), false, "同组已有五条在跑：挂着请求的等着");
    const waiting = await view(ids[5]!);
    assert.equal(waiting.waiting, true);
    assert.match(waiting.holdup ?? "", /同组已有 5 条在跑/);
    assert.doesNotMatch(waiting.holdup ?? "", /前置/, "没有前置的任务不说「在等前置」");

    release(ids[0]!);
    await finished(ids[0]!);
    await sleep(400);
    assert.equal(hasStarted(ids[5]!), false, "降到四条还是满的");
    assert.match((await view(ids[5]!)).holdup ?? "", /同组已有 4 条在跑/);
    release(ids[1]!);
    await finished(ids[1]!);
    await until("降到三条：第六条起了", () => hasStarted(ids[5]!));
    assert.equal((await view(ids[5]!))?.waiting ?? false, false);
    for (const id of ids) release(id);
    for (const id of ids) await finished(id);

    // 不在分组里的共用一个公共桶，那一句也照实说。
    const loose = await members(p, "l5-", 5, { group: null });
    const turns = loose.slice(0, 4).map((id) => runs.claimTurn(id, "single") && runs.turnIdentity(id)!);
    await requestLaunch([loose[4]!], { source: "run" });
    await releaseLaunch(loose[4]!);
    assert.equal(hasStarted(loose[4]!), false);
    assert.match((await view(loose[4]!)).holdup ?? "", /不在分组里的任务已有 4 条在跑/);
    loose.slice(0, 4).forEach((id, index) => runs.releaseTurn(id, turns[index]!));
    await until("公共桶空出来：起了", () => hasStarted(loose[4]!));
    release(loose[4]!);
    await finished(loose[4]!);
    console.log("PASS L2/L5: manual run is not blocked but counts; a capacity wait says what it waits for, never 「在等前置」");
  }

  // ── L3 审查回合不算；L4 队列推进不拦 ───────────────────────────────────────
  {
    const p = await project();
    const ids = await members(p, "l3-", 6);
    const reviews = ids.slice(0, 4).map((id) => runs.claimTurn(id, "reviewer") && runs.turnIdentity(id)!);
    await requestLaunch([ids[4]!], { source: "run" });
    await releaseLaunch(ids[4]!);
    await until("审查回合不占名额：照起", () => hasStarted(ids[4]!));
    ids.slice(0, 4).forEach((id, index) => runs.releaseTurn(id, reviews[index]!));
    release(ids[4]!);
    await finished(ids[4]!);

    const full = await members(p, "l4-", 4);
    await requestLaunch(full, { source: "group" });
    await sweepLaunchRequests();
    await until("组里满四条", () => full.every(hasStarted));
    const queueId = `${p.key}-q`;
    await db.insert(schema.queueItems).values({ taskId: ids[5]!, queueId, position: 0, createdAt: new Date().toISOString() });
    await advanceQueue(queueId);
    await until("队列推进不受名额限制", () => hasStarted(ids[5]!));
    assert.equal(await runningInGroup(p.group), 5);
    for (const id of [...full, ids[5]!]) release(id);
    for (const id of [...full, ids[5]!]) await finished(id);
    await db.delete(schema.queueItems).where(eq(schema.queueItems.queueId, queueId));
    console.log("PASS L3/L4: review side turns don't take capacity; queue advance is not blocked by it");
  }

  // ── L6 被名额挡住时点停止 ──────────────────────────────────────────────────
  {
    const p = await project();
    const ids = await members(p, "l6-", 5);
    await runGroup(p.group);
    await until("先起四条", () => startedOf(ids).length === PARALLEL_LIMIT);
    const [waiter] = ids.filter((id) => !hasStarted(id));
    assert.ok((await launchRecord(waiter!))?.requestedAt);
    assert.equal((await request("POST", `/tasks/${waiter}/stop`)).status, 200);
    assert.equal((await launchRecord(waiter!))?.requestedAt ?? null, null, "停止撤回请求");
    assert.equal((await view(waiter!))?.waiting ?? false, false, "页面上的「在等」随之消失");
    for (const id of ids) release(id);
    for (const id of ids.filter((id) => id !== waiter)) await finished(id);
    await sweepLaunchRequests();
    await sleep(500);
    assert.equal(hasStarted(waiter!), false, "腾出名额、再扫一遍都不再起它");
    assert.equal((await row(waiter!)).status, "backlog");
    console.log("PASS L6: stopping a capacity-waiting task withdraws it for good");
  }

  // ── L7 分组暂停按住请求；放开后照请求起；被暂停打断的从会话续跑 ───────────
  {
    const p = await project();
    const [resumed, held] = await members(p, "l7-", 2);
    await requestLaunch([resumed!], { source: "group" });
    await sweepLaunchRequests();
    await until("先起一条", () => hasStarted(resumed!));
    await pauseGroup(p.group);
    await until("被暂停打断", async () => (await row(resumed!)).status === "paused" && !runs.turnIdentity(resumed!));
    await requestLaunch([held!], { source: "run" });
    await releaseLaunch(held!);
    await sweepLaunchRequests();
    await sleep(300);
    assert.equal(hasStarted(held!), false, "分组暂停：挂着请求的不起");
    assert.ok((await launchRecord(held!))?.requestedAt, "请求原样留着");
    assert.match((await view(held!)).holdup ?? "", /暂停/);
    const sessionsBefore = await db.select().from(schema.sessions).where(eq(schema.sessions.taskId, resumed!));
    assert.equal((await request("POST", `/groups/${p.group}/run`)).status, 202);
    await until("接着跑：照请求起", () => hasStarted(held!));
    await until("被打断的那条续跑", () => inputsOf(resumed!).length === 2);
    const sessionsAfter = await db.select().from(schema.sessions).where(eq(schema.sessions.taskId, resumed!));
    assert.equal(sessionsAfter.length, sessionsBefore.length, "从它自己的会话续跑，不是新开一条");
    for (const id of [resumed!, held!]) release(id);
    for (const id of [resumed!, held!]) await finished(id);
    console.log("PASS L7: group pause holds requests, resume starts them, and interrupted members continue their own session");
  }

  // ── L8 团队执行者 ──────────────────────────────────────────────────────────
  {
    const p = await project();
    const lead = await p.task("l8-lead", { useWorktree: false });
    await db.update(tasks).set({ mode: "team", groupId: null, status: "idle" }).where(eq(tasks.id, lead));
    const workers = await members(p, "l8-w", 6);
    for (const id of workers) await db.update(tasks).set({ parentId: lead }).where(eq(tasks.id, id));
    const sample = peak(workers);
    await runGroup(p.group);
    await until("执行者先起四条", () => startedOf(workers).length === PARALLEL_LIMIT);
    await sleep(300);
    assert.equal(startedOf(workers).length, PARALLEL_LIMIT, "执行者同样受名额限制");
    for (const id of workers) release(id);
    await until("执行者都起了", () => startedOf(workers).length === workers.length);
    for (const id of workers) await finished(id);
    assert.ok(sample.stop() <= PARALLEL_LIMIT);
    console.log("PASS L8: team executors are still started by the group run and still capped");
  }

  await launchRequestFailureCases();
  console.log("launch request: ok");
} finally {
  await teardown();
}
