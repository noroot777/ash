// 起跑前那道冻结闸的回归（第 1 轮审查 finding 1）。
//
// 复现的现场：点「暂停分组」已经 200 返回，重试按钮拉起的 CLI 照样跑起来（20 轮 20 中）。
// 原因是那一小段窗口里，这一轮**既没有 handle 可杀、tasks.status 也还停在上一轮的终态**，
// 暂停的两条扫描线索一条都够不着它。修法是两头堵：暂停侧补一个内存标记（freezeStartingTurn），
// 启动侧在真正 spawn 之前消费它并再核一遍库里的冻结事实（turn-freeze.ts）。
//
// 跑：npm -w server run test:turn-freeze
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "harness-turn-freeze-"));
process.env.HARNESS_DB = join(root, "harness.db");
process.env.HARNESS_RUNS_DIR = join(root, "runs");

try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { groups, projects, sessions: sessionsTable, tasks } = await import("../src/db/schema.js");
  const { claimTurn, continueWhenIdle, freezeStartingTurn, isTurnClaimed, releaseTurn, takeStopped } =
    await import("../src/runs.js");
  const { abortIfFrozen, FrozenTurn, turnFreezeReason } = await import("../src/turn-freeze.js");
  const { pauseGroup } = await import("../src/scheduler.js");
  await ensureSchema();

  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "test", repoPath: root, apiKeys: null, workflowId: null, createdAt: at });
  await db.insert(groups).values({ id: "g", projectId: "p", name: "组", mode: "parallel", paused: false, createdAt: at });
  const task = (id: string, over: Record<string, unknown> = {}) => ({
    id, projectId: "p", groupId: "g", title: id, body: "b", status: "done", mode: "single",
    agentType: "claude", workflowMode: "standard", useWorktree: false, createdAt: at, updatedAt: at,
    ...over,
  });
  await db.insert(tasks).values([task("t1"), task("t2"), task("solo", { groupId: null })] as never);

  // ── 内存标记：只有「回合已占位」时才记得下，也只消费一次 ────────────────────
  assert.equal(freezeStartingTurn("t1"), false, "没有回合在起跑时无事可做");
  assert.equal(await turnFreezeReason("t1"), null, "没标记 + 不查库 → 放行");
  assert.ok(claimTurn("t1", "single"), "占住 t1 的回合");
  assert.equal(freezeStartingTurn("t1"), true, "回合已占位 → 记下冻结意图");
  assert.equal((await turnFreezeReason("t1"))?.settle, "paused", "起跑前的闸消费它并按 paused 结算");
  assert.equal(await turnFreezeReason("t1"), null, "标记只消费一次，不留给后面的回合");

  // 冻结意图只属于当前这一回合：留到下一轮就是「刚起跑就被上一次的暂停莫名冻掉」。
  freezeStartingTurn("t1");
  releaseTurn("t1");
  assert.ok(claimTurn("t1", "single"), "重新占位");
  assert.equal(await turnFreezeReason("t1"), null, "releaseTurn 必须清掉没被消费的标记");

  // ── 查库那一档：分组暂停 / 归档 / 任务已删 ──────────────────────────────────
  assert.equal(await turnFreezeReason("t1", true), null, "一切正常 → 放行");
  await db.update(groups).set({ paused: true }).where(eq(groups.id, "g"));
  assert.equal((await turnFreezeReason("t1", true))?.settle, "paused", "分组已暂停 → 撤回并按 paused 结算");
  assert.equal(await turnFreezeReason("t1"), null, "不开 checkFacts 就不查库（普通续聊照旧允许）");
  await db.update(groups).set({ paused: false }).where(eq(groups.id, "g"));
  await db.update(tasks).set({ archived: true }).where(eq(tasks.id, "t1"));
  assert.equal((await turnFreezeReason("t1", true))?.settle, "canceled", "归档任务 → 撤回并按 canceled 结算");
  await db.update(tasks).set({ archived: false }).where(eq(tasks.id, "t1"));
  assert.equal((await turnFreezeReason("不存在", true))?.settle, "canceled", "任务已删 → 撤回");
  releaseTurn("t1");

  // ── 撤回时怎么结算 ──────────────────────────────────────────────────────────
  // 两条 catch 都是 takeStopped() ?? followUpFrom ?? "failed"。有原终态可回时标了停止落位，
  // 会把一个 done 的任务写成 paused；没原终态时不标，一次暂停就看着像崩了。
  assert.ok(claimTurn("t1", "single"));
  freezeStartingTurn("t1");
  await assert.rejects(() => abortIfFrozen("t1", { restorable: true }), (e: unknown) => e instanceof FrozenTurn, "命中就抛错，交给原有的 catch 收尾");
  assert.equal(takeStopped("t1"), null, "续聊有原终态可回 → 不许抢在 followUpFrom 前面结算");
  freezeStartingTurn("t1");
  await assert.rejects(() => abortIfFrozen("t1"), (e: unknown) => e instanceof FrozenTurn);
  assert.equal(takeStopped("t1"), "paused", "没有原终态时必须标停止落位，否则落成 failed");
  await abortIfFrozen("t1", { checkFacts: true });
  releaseTurn("t1");

  // ── 暂停分组：正在起跑（已 claim、没 handle）的那一轮也得冻住 ────────────────
  assert.ok(claimTurn("t1", "single"), "t1 已占位、还没 spawn —— 正是复现出来的那个窗口");
  await pauseGroup("g");
  assert.equal((await turnFreezeReason("t1"))?.settle, "paused", "杀不到就必须留下冻结标记");
  assert.equal(await turnFreezeReason("t2"), null, "没有回合在起跑的成员不留标记");
  releaseTurn("t1");
  // 分组外的任务不受这次暂停影响（freezeStartingTurn 只按成员扫描）。
  assert.ok(claimTurn("solo", "single"));
  await pauseGroup("g");
  assert.equal(await turnFreezeReason("solo"), null, "别的分组暂停不该冻住不相干的任务");
  releaseTurn("solo");

  console.log("✓ turn freeze gate");

  // ── 闸的**位置**：必须在真正 spawn 之前 ─────────────────────────────────────
  // 这条才是 finding 1 的要害。continueTask 自己把异常吞在 catch 里（照常结算、发一条
  // error 事件），所以判据取那条事件的措辞：闸要是排在 ex.run 之后，这里读到的就会是
  // 执行器那边的报错（测试环境禁止真起 CLI），而不是「启动前被撤回」。
  const { continueTask } = await import("../src/orchestrator.js");
  const { agents } = await import("../src/db/schema.js");
  const { bus } = await import("../src/bus.js");
  await db.insert(agents).values({
    id: "a1", name: "claude@test", type: "claude", model: null,
    extraArgs: "[]", reasoningEffort: null, speed: null, providerId: null, isDefault: true,
  });
  const errors: string[] = [];
  const off = bus.subscribe((ev) => {
    if (ev.type === "agent.event" && ev.event.kind === "error") errors.push(ev.event.message);
  });
  assert.ok(claimTurn("t2", "single"));
  freezeStartingTurn("t2");
  assert.equal(await continueTask("t2", "再试一次", { turnHeld: true }), true, "这一轮确实由本次调用接管了");
  off();
  assert.equal(errors.length, 1, "撤回要如实报一条错误事件");
  assert.match(errors[0], /启动前被撤回/, "起跑闸必须排在 spawn 之前：拿到的应当是撤回，不是执行器的报错");
  const after = (await db.select().from(tasks).where(eq(tasks.id, "t2"))).at(0);
  assert.equal(after?.status, "done", "撤回后回到续聊前的终态，不是 failed");
  assert.equal((await db.select().from(sessionsTable).where(eq(sessionsTable.taskId, "t2"))).length, 0, "撤回的回合不该留下会话行");

  console.log("✓ turn freeze happens before spawn");

  // ── 占位交接：占位期间的暂停必须传到真正接管的那一轮 ─────────────────────────
  // 手动派验证、自由派审/修复都是同一个形状：先 `claimTurn(id, "dispatch")` 占位（覆盖
  // 「校验通过到排队注册」这一段），把真回合用 `continueWhenIdle` 挂在释放点后面，finally
  // `releaseTurn`。`releaseTurn` 的顺序是**先清掉起跑冻结标记、再排空 after-turn 回调**，
  // 于是接棒的 reviewer claim 得到、却拿不到刚才那次暂停：用户已经收到「暂停成功」，CLI
  // 照样被拉起（第 4 轮审查确定性复现，也是项目里出过的那起事故的形状）。
  //
  // 修法不是把标记留到下一轮（一个过期标记会盖过库里的事实，把一次合法启动错误撤回），
  // 而是让这条路上的接管在 spawn 之前**按库里的事实**再核一次——这条路上的启动全是系统
  // 发起的，慢一点没关系，错起来才要命。
  {
    await db.update(groups).set({ paused: false }).where(eq(groups.id, "g"));
    const before = (await db.select().from(tasks).where(eq(tasks.id, "t1"))).at(0);

    assert.ok(claimTurn("t1", "dispatch"), "派活方先占位");
    const reported: string[] = [];
    continueWhenIdle("t1", "开始审查", { sessionRole: "reviewer" }, (msg) => { reported.push(msg); });
    await pauseGroup("g"); // 用户此刻点了「暂停分组」
    releaseTurn("t1");     // 派活方的 finally：交棒给真回合
    for (let i = 0; i < 200 && reported.length === 0; i++) await new Promise((r) => setTimeout(r, 10));

    // 判据是**回报**而不只是「没起来」：调用方（startVerifyRound 等）要靠这条回报回滚
    // verifyRound / stage，否则任务会永远卡在「已有一轮验证正在进行」。
    assert.equal(reported.length, 1, "接管的那一轮必须被撤回，并如实回报给调用方");
    assert.match(reported[0], /暂停/, "要说清为什么撤回");
    assert.match(reported[0], /启动前被撤回/, "而且要说清一个字都还没送出去");
    assert.equal(isTurnClaimed("t1"), false, "撤回要把回合还回去，否则这个任务再也起不来");
    assert.equal(takeStopped("t1"), null, "一个字都没送出去，不该标停止落位去改写终态");
    assert.equal(
      (await db.select().from(sessionsTable).where(eq(sessionsTable.taskId, "t1"))).length, 0,
      "撤回的回合不该留下会话行",
    );
    const after = (await db.select().from(tasks).where(eq(tasks.id, "t1"))).at(0);
    assert.equal(after?.status, before?.status, "撤回不该动任务状态");

    // 反向对照：分组恢复之后，同一条交接必须能正常接管——上面那条不能是「一律撤回」。
    await db.update(groups).set({ paused: false }).where(eq(groups.id, "g"));
    const errs: string[] = [];
    const offAgain = bus.subscribe((ev) => {
      if (ev.type === "agent.event" && ev.event.kind === "error") errs.push(ev.event.message);
    });
    assert.ok(claimTurn("t1", "dispatch"));
    const reported2: string[] = [];
    continueWhenIdle("t1", "开始审查", { sessionRole: "reviewer" }, (msg) => { reported2.push(msg); });
    releaseTurn("t1");
    for (let i = 0; i < 200 && errs.length === 0 && reported2.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    offAgain();
    assert.deepEqual(reported2, [], "分组没暂停就不该撤回");
    // 测试环境不许真起 CLI，所以这一轮会停在执行器那边；判据是它**走到了那一步**。
    assert.ok(errs.length >= 1, "没暂停时必须真的交给 continueTask 去跑");
    for (const err of errs) {
      assert.doesNotMatch(err, /启动前被撤回/, "拿到的应当是执行器的报错，不是起跑闸的撤回");
    }
  }

  console.log("✓ dispatch 占位期间的暂停传到了接管的那一轮");
} finally {
  rmSync(root, { recursive: true, force: true });
}
