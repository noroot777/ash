// 从哪条任务里出来的，就收在哪条下面：系统替用户从一条任务里切出来的任务 —— 裁定「转成独立任务」
// 建的那条、合并结果审查建的修复任务 —— 建出来就在来源名下（tasks.dispatched_by），和智能体派出去的
// 是同一棵树。判据在 src/task-dispatch.ts，存量补记在 src/db/migrate-dispatched-by.ts。
//
// 钉住的是这几件事：
//   · 两条路建出来就在来源名下；来源是团队执行者 / 讨论 / 团队调度台时不记；
//   · 其余一样没动：来源回链、创建来源、待办不起跑；执行器照来源那条，不问来源「派出去的活交给谁」；
//   · 认「切出来的」要看是不是系统建的：你或智能体派出去的普通任务同时回链到派它的那条，仍是派出去
//     的活，照旧拿来源「派出去的活交给谁」的默认值（建任务的接口记不出「系统」这个创建来源）；
//   · 转出的再转出：一层一层往下收；在来源或更上层按「全部停下」管得到最底下那条；
//   · 存量补记：这两条路建的补上；只带来源回链的手动派生不动；已有归属的不改写；审查记录和回链
//     对不上的不补；重复跑不出新变化；规则上线之后建的（落在边界之后）不碰。
//
// 跑：npm -w @ash/server run test:carved-out-home
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-carved-out-home-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
delete process.env.ASH_ALLOW_REAL_AGENT;

const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { appSettings, freeReviewRounds, freeReviewRuns, projects, tasks } = await import("../src/db/schema.js");
const { backfillDispatchedBy, DISPATCHED_BY_BACKFILL_KEY } = await import("../src/db/migrate-dispatched-by.js");
const { deferOpenDispute } = await import("../src/free-review-defer.js");
const { createPostMergeRepairTask } = await import("../src/post-merge-review.js");
const { dispatchTree, holdDispatched } = await import("../src/dispatch-hold.js");
const { dispatchHoldOf, taskHoldOf } = await import("../src/task-hold.js");
const { createTasks } = await import("../src/task-store.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
await ensureSchema();
const api = new Hono();
mountTaskRoutes(api);

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const at = minutesAgo(30);
type NewTask = typeof tasks.$inferInsert;
const row = (id: string, extra: Partial<NewTask> = {}): NewTask => ({
  id, projectId: "project", title: id, body: "", agentType: "claude", workflowMode: "free", createdAt: at, updatedAt: at, ...extra,
});
const taskOf = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
const homeOf = async (id: string) => (await taskOf(id)).dispatchedBy ?? null;
const markOf = async () => JSON.parse(String((await db.select().from(appSettings)
  .where(eq(appSettings.key, DISPATCHED_BY_BACKFILL_KEY))).at(0)?.value ?? "null")) as { cutoff: string; carved?: string } | null;

let reviews = 0;
/** 给一条任务挂一轮「未通过、执行者提了转出、等着裁定」的审查；deferredTaskId 给了就是已经裁定转出的老记录。 */
async function reviewOn(taskId: string, opts: { deferredTaskId?: string; repairTaskId?: string; merge?: boolean } = {}) {
  const runId = `${taskId}-run-${String(++reviews).padStart(3, "0")}`;
  await db.insert(freeReviewRuns).values({
    id: runId, taskId, reviewerId: null, reviewerName: "逻辑审查者", agentType: "codex", checkMode: "logic",
    retryLimit: 1, currentRound: 1, status: "stopped", createdAt: at, updatedAt: at, finishedAt: at,
    ...(opts.merge || opts.repairTaskId
      ? { targetKind: "accepted_merge", targetBranch: "main", targetBaseCommit: "base", targetCommit: "merge" } : {}),
    repairTaskId: opts.repairTaskId ?? null,
  });
  await db.insert(freeReviewRounds).values({
    id: `${runId}-round`, runId, round: 1, status: "failed", conclusion: "verify_failed", startedAt: at, endedAt: at,
    disputeDeferReason: "第 2 条成立，但落在别的模块上，不属于本任务",
    ...(opts.deferredTaskId ? { disputeResolution: "deferred", disputeResolvedAt: at, disputeDeferredTaskId: opts.deferredTaskId } : {}),
  });
  if (opts.merge) {
    const evidence = join(root, "runs", taskId, "free-review", runId, "round-1");
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "report.md"), "# 未通过\n\n合并后的入口状态不符合预期。\n");
  }
  return runId;
}

/** 照用户裁定「转成独立任务」走一遍。 */
async function carve(sourceId: string) {
  const runId = await reviewOn(sourceId);
  const run = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, runId))).at(0)!;
  const round = (await db.select().from(freeReviewRounds).where(eq(freeReviewRounds.runId, runId))).at(0)!;
  return deferOpenDispute(await taskOf(sourceId), { run, round });
}

try {
  await db.insert(projects).values({ id: "project", name: "切出来的任务", repoPath: root, createdAt: at });

  // ── 存量补记 ──────────────────────────────────────────────────────────────────────────
  // 老实例：「派它的那条任务」早就上线了（头一条边界在一小时前），切出来的这条规则刚上线。
  assert.ok((await markOf())?.carved, "空库首启把两条边界一起记下");
  await db.insert(appSettings).values({ key: DISPATCHED_BY_BACKFILL_KEY, value: JSON.stringify({ cutoff: minutesAgo(60) }) })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: JSON.stringify({ cutoff: minutesAgo(60) }) } });
  const agentMade = JSON.stringify({ kind: "agent", taskId: "old-top", agentType: "claude" });
  await db.insert(tasks).values([
    row("old-top"),
    row("old-src", { dispatchedBy: "old-top" }),
    row("old-carved", { originTaskId: "old-src" }),
    row("old-carved-again", { originTaskId: "old-carved" }),
    row("old-repair", { originTaskId: "old-src" }),
    row("manual-fork", { originTaskId: "old-src", creationOrigin: JSON.stringify({ kind: "user" }) }),
    row("elsewhere"),
    row("already-homed", { originTaskId: "old-src", dispatchedBy: "elsewhere" }),
    row("mismatched", { originTaskId: "elsewhere" }),
    row("team", { mode: "team" }),
    row("worker", { parentId: "team" }),
    row("from-worker", { originTaskId: "worker" }),
    row("duet", { mode: "duet" }),
    row("from-duet", { originTaskId: "duet" }),
    row("from-team", { originTaskId: "team" }),
    // 头一条边界之后、明确选了不归属的智能体任务：这条规则上线也不能把它挂回去。
    row("opted-out", { creationOrigin: agentMade }),
    // 规则上线之后才写进库的（时间落在新边界之后）：新代码当场判定过了，补记不碰。
    row("after-upgrade", { originTaskId: "old-src", createdAt: new Date(Date.now() + 60_000).toISOString() }),
  ]);
  await reviewOn("old-src", { deferredTaskId: "old-carved" });
  await reviewOn("old-carved", { deferredTaskId: "old-carved-again" });
  await reviewOn("old-src", { repairTaskId: "old-repair" });
  await reviewOn("old-src", { deferredTaskId: "already-homed" });
  await reviewOn("old-src", { deferredTaskId: "mismatched" });
  await reviewOn("worker", { deferredTaskId: "from-worker" });
  await reviewOn("duet", { deferredTaskId: "from-duet" });
  await reviewOn("team", { repairTaskId: "from-team" });
  await reviewOn("old-src", { deferredTaskId: "after-upgrade" });

  await backfillDispatchedBy(dbClient as never);
  assert.equal(await homeOf("old-carved"), "old-src", "裁定转出建的那条补到来源名下");
  assert.equal(await homeOf("old-repair"), "old-src", "合并结果审查建的修复任务补到来源名下");
  assert.equal(await homeOf("old-carved-again"), "old-carved", "转出的再转出：收在它自己的来源下面，一层一层往下");
  assert.equal(await homeOf("manual-fork"), null, "只带来源回链的手动派生不动（有 originTaskId 不是判据）");
  assert.equal(await homeOf("already-homed"), "elsewhere", "已经有归属的不改写");
  assert.equal(await homeOf("mismatched"), null, "审查记录和它回链的来源对不上：认不准的不补");
  assert.equal(await homeOf("from-worker"), null, "来源是团队执行者的不记");
  assert.equal(await homeOf("from-duet"), null, "来源是讨论的不记");
  assert.equal(await homeOf("from-team"), null, "来源是团队调度台的不记");
  assert.equal(await homeOf("opted-out"), null, "头一条边界之后明确不归属的，照旧碰不到");
  assert.equal(await homeOf("after-upgrade"), null, "规则上线之后建的不归补记管");
  assert.equal(await homeOf("old-src"), "old-top", "来源自己的归属没被动");
  const mark = await markOf();
  assert.ok(mark?.carved && mark.carved > mark.cutoff, "头一条边界不挪，另记这条规则上线的时刻");
  const oldTree = await dispatchTree("old-top");
  assert.deepEqual([...oldTree].sort(), ["old-carved", "old-carved-again", "old-repair", "old-src"],
    "最上面那条往下数得到最底下那条（全部停下、变色判据都顺着这棵走）");
  assert.equal(oldTree.at(0), "old-src");
  assert.equal(oldTree.at(-1), "old-carved-again", "按层往下");

  const snapshot = async () => (await db.select({ id: tasks.id, by: tasks.dispatchedBy }).from(tasks)).sort((a, b) => a.id.localeCompare(b.id));
  const before = await snapshot();
  await backfillDispatchedBy(dbClient as never);
  assert.deepEqual(await snapshot(), before, "重复跑不出新变化");
  assert.deepEqual(await markOf(), mark, "边界只记一次");

  // ── 新建：裁定「转成独立任务」────────────────────────────────────────────────────────
  // 来源自己两样都空着（跟随默认执行器），又设了「派出去的活交给谁」：切出来的那条照来源，不照那个默认值。
  const otherTarget = JSON.stringify({ agentType: "codex", executorId: "other-executor", model: "gpt-test", reasoningEffort: "high" });
  await db.insert(tasks).values([
    row("top"),
    row("src", { dispatchedBy: "top", agentType: null, executorId: null, dispatchTarget: otherTarget, groupId: null, mergeTargetBranch: "main" }),
    row("named", { dispatchedBy: "top", agentType: "claude", executorId: "mine", dispatchTarget: otherTarget }),
  ]);
  const carved = await carve("src");
  assert.equal(carved.dispatchedBy, "src", "裁定转出建的任务建出来就在来源名下");
  assert.equal(carved.originTaskId, "src", "来源回链照旧");
  assert.deepEqual(carved.creationOrigin, { kind: "system" }, "创建来源照旧是系统");
  assert.equal(carved.status, "backlog", "照旧是待办、不起跑");
  assert.equal(carved.parentId ?? null, null);
  assert.equal(carved.mergeTargetBranch, "main", "合入分支照来源");
  assert.equal(carved.title, "src · 承接第 1 轮审查的越界意见", "标题照旧");
  const carvedRow = await taskOf(carved.id);
  assert.equal(carvedRow.agentType, null, "执行器照来源那条（来源跟随默认，它也跟随默认）");
  assert.equal(carvedRow.executorId, null, "不受来源「派出去的活交给谁」影响");
  assert.equal(carvedRow.model, null);
  const carvedNamed = await taskOf((await carve("named")).id);
  assert.deepEqual([carvedNamed.agentType, carvedNamed.executorId, carvedNamed.dispatchedBy], ["claude", "mine", "named"]);

  // ── 回链到派它的那条的普通派活不是切出来的 ────────────────────────────────────────────
  // 「收在来源名下」只说明挂在哪、回链到哪。建任务的接口允许两样同时给，创建来源由服务端记成用户 /
  // 智能体：这种任务没指明交给谁时，照旧拿来源「派出去的活交给谁」的默认值，跟不带回链的一模一样。
  const post = async (body: Record<string, unknown>) => (await api.request("/tasks", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "project", useWorktree: false, title: "派出去的普通任务", ...body }),
  })).json() as Promise<Record<string, unknown>>;
  const assignment = (task: Record<string, unknown>) => [task.agentType, task.model, task.reasoningEffort, task.dispatchedBy];
  const plain = await post({ dispatchedBy: "src" });
  const linked = await post({ dispatchedBy: "src", originTaskId: "src" });
  assert.deepEqual(plain.creationOrigin, { kind: "user" });
  assert.deepEqual(linked.creationOrigin, { kind: "user" }, "建任务的接口记不出「系统」这个创建来源");
  assert.equal(linked.originTaskId, "src");
  assert.deepEqual(assignment(plain), ["codex", "gpt-test", "high", "src"], "前提：不带回链的普通派活拿到来源的派活默认值");
  assert.deepEqual(assignment(linked), assignment(plain), "同时回链到派它的那条：仍是派出去的活，默认值照给");
  const [byAgent] = await createTasks([{
    ...row("agent-linked", { agentType: null, originTaskId: "src", dispatchedBy: "src" }),
    creationOrigin: JSON.stringify({ kind: "agent", taskId: "src", agentType: "claude" }),
  }]);
  assert.deepEqual(assignment(byAgent as never), ["codex", "gpt-test", "high", "src"], "智能体派的同样");

  assert.equal((await carve("worker")).dispatchedBy ?? null, null, "来源是团队执行者：不记");
  assert.equal((await carve("duet")).dispatchedBy ?? null, null, "来源是讨论：不记");
  assert.equal((await carve("team")).dispatchedBy ?? null, null, "来源是团队调度台：不记");

  // ── 新建：合并结果审查的修复任务 ─────────────────────────────────────────────────────
  await db.update(tasks).set({ stage: "accepted", status: "done" }).where(eq(tasks.id, "named"));
  const repair = await createPostMergeRepairTask("named", await reviewOn("named", { merge: true }));
  assert.equal(repair.dispatchedBy, "named", "修复任务建出来就在来源名下");
  assert.equal(repair.originTaskId, "named");
  assert.deepEqual(repair.creationOrigin, { kind: "system" });
  assert.equal(repair.status, "backlog");
  assert.deepEqual([repair.agentType, repair.executorId], ["claude", "mine"], "执行器照来源那条");
  await db.update(tasks).set({ stage: "accepted", status: "done" }).where(eq(tasks.id, "worker"));
  const workerRepair = await createPostMergeRepairTask("worker", await reviewOn("worker", { merge: true }));
  assert.equal(workerRepair.dispatchedBy ?? null, null, "来源是团队执行者的修复任务：不记");

  // ── 转出的再转出，以及在上面按「全部停下」────────────────────────────────────────────
  const deeper = await carve(carved.id);
  assert.equal(deeper.dispatchedBy, carved.id, "转出的再转出一条：收在转出的那条下面");
  const below = await dispatchTree("top");
  assert.ok([carved.id, deeper.id, repair.id].every((id) => below.includes(id)), "最上面那条名下数得到每一层切出来的");
  assert.ok(below.indexOf("src") < below.indexOf(carved.id) && below.indexOf(carved.id) < below.indexOf(deeper.id), "一层一层往下");

  // 最底下那条排着：在来源上按「全部停下」，它退回待办、起不了；再往上一层按，说得出是被谁按住的。
  await db.update(tasks).set({ status: "queued" }).where(eq(tasks.id, deeper.id));
  const held = await holdDispatched("src");
  assert.ok([carved.id, deeper.id].every((id) => held.tree.includes(id)), "在来源那条上按，管到它切出去的整棵");
  assert.ok(!held.tree.includes("named") && !held.tree.includes(repair.id), "同一层别处的那一棵不受影响");
  assert.equal((await taskOf(deeper.id)).status, "backlog", "排着的那条被停下");
  assert.equal((await dispatchHoldOf(deeper.id))?.byTaskId, "src");
  assert.equal((await taskHoldOf(await taskOf(carved.id)))?.kind, "dispatch", "各处起跑的闸问的就是这一句");
  await db.update(tasks).set({ dispatchHoldAt: null, holdOwedBy: null }).where(eq(tasks.id, "src"));
  await db.update(tasks).set({ holdOwedBy: null }).where(eq(tasks.id, deeper.id));
  assert.equal(await dispatchHoldOf(deeper.id), null);
  assert.ok((await holdDispatched("top")).tree.includes(deeper.id), "在最上面那条上按，同样管得到最底下那条");
  assert.equal((await dispatchHoldOf(deeper.id))?.byTaskId, "top");
  assert.equal((await dispatchHoldOf(repair.id))?.byTaskId, "top");

  console.log("✓ 切出来的任务收在来源下面：两条路建出来就记、团队与讨论那一侧不记、执行器照来源、一层一层往下、全部停下管得到、存量只补认得准的");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
