// 「放锁只能放自己那一把」的回归(第 2 轮独立审查 F1)。
//
// 现场:人工放开一把卡住的锁(seq=1)之后,一个正常回合合法占上(seq=2);**旧操作稍晚收尾**,
// 它那个只记着 taskId 的释放闭包照样把 seq=2 删掉并排空它的等待队列,于是同一个任务可以
// 第三次认领 —— 两轮并跑,一起改同一个工作目录。审查用生产构建产物实测到
// `thirdClaimed=true`。
//
// 根因不在某一个闭包上:`releaseTurn(taskId)` / `endTurn(taskId)` 这种「按任务 id 放锁」的
// 形态**在占位与释放之间隔着 await 时根本无法判断锁还是不是自己那一把**,而人工放开是一条
// 正当入口,它随时可以在那段间隙里把锁拔走。所以修的是原语:`endOwnTurn` 只放 seq 对得上的
// 那一把,三件事(删锁 / 排空 afterTurn / 清起跑冻结)全收在核验之后。
//
// 这份回归钉的是**不变量本身**,按生产里真实存在的那几种持有形态逐一验:
//   ① 预占闭包(`claimNonTurn` → queue-seat 的回滚、残留结算)跨代次不生效;
//   ② 旧代次不触发新锁的 afterTurn(那串交接是后来者那一轮结束时才该走的);
//   ③ 旧代次不清新锁的起跑冻结标记(清掉 = 下一轮该撤回的暂停意图凭空消失);
//   ④ 占位转正(`reclaimTurn`)同样按 owner 核:它是整份覆写锁身份,旧代次转正会把后来者
//      那一轮改成自己的角色;
//   ⑤ 生产入口 `enterTurn(turnHeld=旧身份)`:锁被拔走之后它只能说「这一轮不起」,而且
//      不许顺手还掉别人那把;
//   ⑥ 兼容面(布尔版 `claimTurn` + 不核凭据的 `releaseHeldTurn`)仍然工作 —— 回归脚本里
//      两百多处「同一段同步代码里 claim 完马上 release」靠它,那种形状下凭据没有信息量。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-turn-release-ownership-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

const { ensureSchema, db, dbClient } = await import("../src/db/index.js");
const { projects } = await import("../src/db/schema.js");
const { createTasks } = await import("../src/task-store.js");
const {
  claimNonTurn, claimOwnTurn, claimTurn, claimWorkspaceTurn, freezeStartingTurn, isTurnClaimed,
  reclaimTurn, releaseHeldTurn, releaseTurn, SEAT_ROLLBACK_ROLE, takeStartFreeze, turnIdentity,
  whenTurnIdle,
} = await import("../src/runs.js");
const { forceReleaseTurn } = await import("../src/turn-lock.js");
const { enterTurn } = await import("../src/turn-entry-guard.js");

await ensureSchema();
const stamp = new Date().toISOString();
await db.insert(projects).values({
  id: "p1", name: "turn release ownership", repoPath: join(root, "repo"),
  apiKeys: null, workflowId: null, createdAt: stamp,
});
const baseTask = {
  projectId: "p1", groupId: null, parentId: null, body: "test", mode: "single", status: "failed",
  labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "claude",
  executorId: null, model: null, reasoningEffort: null, autoTitle: false,
  duet: null, team: null, reportBack: false, scheduleId: null,
  createdAt: stamp, updatedAt: stamp,
  useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
};
await createTasks([
  { ...baseTask, id: "t-rollback", title: "rollback" },
  { ...baseTask, id: "t-freeze", title: "freeze" },
  { ...baseTask, id: "t-reclaim", title: "reclaim" },
  { ...baseTask, id: "t-entry", title: "entry" },
]);

// ── ① 预占闭包跨代次不生效(F1 的生产形状)────────────────────────────────────
// `claimNonTurn(SEAT_ROLLBACK_ROLE)` 就是审查实测用的那条路(queue-seat 的回滚):它占住锁、
// 中间 await 一串写操作,收尾时调返回的那个闭包。
{
  const releaseRollback = claimNonTurn("t-rollback", SEAT_ROLLBACK_ROLE);
  assert.ok(releaseRollback, "台子前提:这把回滚锁要占得上");
  const first = turnIdentity("t-rollback");
  assert.ok(first && first.role === SEAT_ROLLBACK_ROLE);

  // 人工放开(判据与阈值在 turn-lock-reclaim.ts,这里直接用它调的那个原语)。
  assert.deepEqual(forceReleaseTurn({ taskId: "t-rollback", seq: first!.seq }), first,
    "人工放开应拔掉 seq=1 并如实交回被拔的那份身份");
  // 一个正常回合随即合法占上。
  const second = claimOwnTurn("t-rollback", "single");
  assert.ok(second, "放开之后新一轮必须占得到");
  assert.notEqual(second!.seq, first!.seq, "新一轮是另一把锁(seq 不复用)");

  releaseRollback!();                       // ← 旧操作稍晚收尾

  assert.equal(turnIdentity("t-rollback")?.seq, second!.seq,
    "**F1 本体**:旧代次的释放闭包一个字节都不许动后来者那把锁");
  assert.equal(claimTurn("t-rollback", "third"), false,
    "互斥必须还在 —— 第三次认领能成功就是同一个任务两个回合并跑");
  // 幂等那一条照旧:重复调用仍然什么都不做(写操作的 finally 与错误路径可能都走到)。
  releaseRollback!();
  assert.equal(turnIdentity("t-rollback")?.seq, second!.seq, "重复调用也不许改判");
  releaseTurn("t-rollback", second!);
  assert.equal(isTurnClaimed("t-rollback"), false, "自己那把要放得掉");
}

// ── ② 旧代次不触发新锁的 afterTurn ────────────────────────────────────────────
// 「等这一轮跑完再送」的交接(排队消息投递、队列补推)压在当前这把锁底下。旧代次把它们
// 排空,后来者真结束时就再没有第二次 —— 任务停在原地,而日志里什么都看不出来。
{
  const stale = claimOwnTurn("t-rollback", "single");
  assert.ok(stale);
  assert.equal(forceReleaseTurn({ taskId: "t-rollback", seq: stale!.seq })?.seq, stale!.seq);
  const current = claimOwnTurn("t-rollback", "single");
  assert.ok(current);
  let handovers = 0;
  whenTurnIdle("t-rollback", () => { handovers += 1; });
  assert.equal(handovers, 0, "锁占着,交接排在队里等");

  releaseTurn("t-rollback", stale!);        // ← 旧代次来还锁
  assert.equal(handovers, 0, "旧代次不许消费后来者那一轮的交接");
  assert.equal(isTurnClaimed("t-rollback"), true, "锁也必须还在");

  releaseTurn("t-rollback", current!);      // ← 真正的持有者
  assert.equal(handovers, 1, "后来者自己还锁时,交接才走");
}

// ── ③ 旧代次不清新锁的起跑冻结标记 ───────────────────────────────────────────
// 标记的语义是「这一轮必须在 spawn 之前撤回」。旧代次把它清掉,用户刚按下的那次暂停就
// 凭空消失,下一轮照跑。
{
  const stale = claimOwnTurn("t-freeze", "single");
  assert.ok(stale);
  assert.equal(forceReleaseTurn({ taskId: "t-freeze", seq: stale!.seq })?.seq, stale!.seq);
  const current = claimOwnTurn("t-freeze", "single");
  assert.ok(current);
  assert.equal(freezeStartingTurn("t-freeze", "paused"), true, "后来者那一轮被暂停冻结");

  releaseTurn("t-freeze", stale!);
  assert.equal(takeStartFreeze("t-freeze"), "paused",
    "旧代次不许清掉后来者的冻结标记 —— 清了等于把这次暂停吃掉");
  releaseTurn("t-freeze", current!);
}

// ── ④ 占位转正同样按 owner 核 ────────────────────────────────────────────────
// `reclaimTurn` 是**整份覆写**锁的 role/review。旧代次转正会把后来者那一轮的身份改成自己
// 的(seq/token 还是后来者的),于是来源核验按一个谁都没授权过的组合放行。
{
  const stale = claimOwnTurn("t-reclaim", "single");
  assert.ok(stale);
  assert.equal(forceReleaseTurn({ taskId: "t-reclaim", seq: stale!.seq })?.seq, stale!.seq);
  const current = claimOwnTurn("t-reclaim", "reviewer", { run: "run-1", round: 2 });
  assert.ok(current);

  assert.equal(reclaimTurn("t-reclaim", stale!, "side"), null,
    "旧代次转正只能说「这把锁不是你那一把了」");
  assert.deepEqual(
    { role: turnIdentity("t-reclaim")?.role, review: turnIdentity("t-reclaim")?.review },
    { role: "reviewer", review: { run: "run-1", round: 2 } },
    "后来者那一轮的身份一个字段都不许被旧代次改写");

  // 自己那把照旧转得正,而且沿用同一个号(同一把锁,不换号)。
  const promoted = reclaimTurn("t-reclaim", current!, "side");
  assert.equal(promoted?.seq, current!.seq);
  assert.equal(promoted?.role, "side");
  assert.deepEqual(promoted?.review, { run: "run-1", round: 2 }, "省略 review = 沿用,不是清掉");
  releaseTurn("t-reclaim", current!);
}

// ── ⑤ 生产入口:锁被拔走之后 enterTurn 不接管、也不误释放 ──────────────────────
// `turnHeld` 这条路上的调用方在入口原子占位、把身份交给下游,中间隔着整段 await。
{
  const handed = claimOwnTurn("t-entry", "single");
  assert.ok(handed);
  assert.equal(forceReleaseTurn({ taskId: "t-entry", seq: handed!.seq })?.seq, handed!.seq);
  const current = claimOwnTurn("t-entry", "single");
  assert.ok(current);

  assert.equal(await enterTurn({ taskId: "t-entry", turnHeld: handed, source: { role: "single" } }), null,
    "交下来的那把锁已经不在手上 ⇒ 这一轮不起");
  assert.equal(turnIdentity("t-entry")?.seq, current!.seq, "而且不许顺手还掉后来者那把");
  releaseTurn("t-entry", current!);

  // 正常形态:没人拔锁时它交回身份,调用方据此还锁。
  const own = claimOwnTurn("t-entry", "single");
  assert.ok(own);
  const taken = await enterTurn({ taskId: "t-entry", turnHeld: own, source: { role: "reviewer", review: "unbound" } });
  assert.equal(taken?.seq, own!.seq, "接管的是同一把锁");
  assert.equal(taken?.role, "reviewer", "身份按这一轮的来源接管");
  releaseTurn("t-entry", taken!);
  assert.equal(isTurnClaimed("t-entry"), false);
}

// ── ⑥ 全有或全无的回退只撤自己占下的那几把 ────────────────────────────────────
{
  const mine = claimOwnTurn("t-freeze", "single");
  assert.ok(mine, "先让其中一位被别人占着");
  assert.equal(claimWorkspaceTurn(["t-reclaim", "t-freeze"]), null, "有一位在跑,整组都不许占");
  assert.equal(turnIdentity("t-freeze")?.seq, mine!.seq, "别人那把锁不许被回退动到");
  assert.equal(isTurnClaimed("t-reclaim"), false, "自己刚占下的那几把要还回去");
  releaseTurn("t-freeze", mine!);
}

// ── ⑦ 兼容面:布尔版 claimTurn + 不核凭据的 releaseHeldTurn ────────────────────
// 它们只配「同一段同步代码里 claim 完马上 release」的形状(中间没有 await ⇒ 没人能把锁
// 换掉 ⇒ 凭据没有信息量),回归脚本两百多处就是这种形状。生产路径由 `releaseTurn` 的签名
// 兜住:少传凭据在 server/src 里编译不过。
{
  assert.equal(claimTurn("t-entry", "compat"), true, "布尔版只回答抢没抢到");
  assert.equal(claimTurn("t-entry", "compat"), false, "占着时第二次就是 false");
  assert.equal(releaseHeldTurn("t-entry")?.role, "compat", "放掉此刻那一把,并如实交回它是谁");
  assert.equal(releaseHeldTurn("t-entry"), null, "没占着就什么都没放");
}

dbClient.close();
console.log("turn release ownership ok");
