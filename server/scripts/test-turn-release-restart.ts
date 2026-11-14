// 队列推进挪到放锁那一刻之后,「该推进」这份责任仍然要跟状态一起落库。
//
// 现场(第 1 轮审查 restart-smoke):串行队列的队首写下续跑交代、落成 paused,回合还在收尾(锁没放)
// 时服务重启。推进当时只记在内存欠账里 —— 重启之后既没有推进意图、也没有推进请求,对账不碰正常的
// paused,队首前面也没有已落终态的前驱,于是谁都不补推:队首一直停在暂停,后面的任务也不再前进。
// 第 2 轮审查又证伪了「状态之后再异步补写意图」:`setTaskStatus` 一返回就退出,意图还没写进去;
// 查队列失败被吞成「不在队列」,正常放锁也推不动。现在意图与状态同一个事务提交(turn-release.ts)。
//
// 三幕:
//   一、子进程占锁、落 paused,`setTaskStatus` 一返回就退出(不等任何后台写);本进程按开机顺序
//      对账 + 恢复,队首必须被叫起来续跑。
//   二、同一进程里正常放锁:放锁那一刻推进,做完之后不留多余的推进意图(否则每次重启平白多推一次)。
//   三、事务里查队列那一下失败:状态那一笔整笔不落(不许出现「状态变了、推进凭据没有」),调用方
//      重试一次照常落库,放锁之后照常推进。
// 只换掉「起一个 CLI」那一步;全程不起 scheduler 的定时 tick。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { AgentEvent } from "@ash/shared";
import type { RunHandle, RunOpts } from "../src/executors/types.js";
import { releaseTmpDb, requireTmpDb } from "./tmp-db.js";

const phase = process.argv[2] ?? "main";
const root = phase === "main" ? mkdtempSync(join(tmpdir(), "ash-release-restart-")) : process.env.RESTART_ROOT!;
if (phase === "main") {
  process.env.ASH_DB = join(root, "ash.db");
  process.env.ASH_RUNS_DIR = join(root, "runs");
}
requireTmpDb("turn-release-restart");
delete process.env.ASH_LAX_DONE;
delete process.env.ASH_ALLOW_REAL_AGENT;

const { ensureSchema, db } = await import("../src/db/index.js");
const { agents, projects, queueAdvanceIntents, queueItems, tasks } = await import("../src/db/schema.js");
const { createTasks } = await import("../src/task-store.js");
const { setTaskStatus } = await import("../src/status.js");
const { claimOwnTurn, isTurnClaimed, releaseTurn } = await import("../src/runs.js");
const { ClaudeExecutor } = await import("../src/executors/claude.js");
const { CodexExecutor } = await import("../src/executors/codex.js");
await ensureSchema();

const launched: string[] = [];
const run = (opts: RunOpts): RunHandle => {
  launched.push(opts.prompt);
  return {
    sessionId: "release-restart", commandLine: "fixture turn", kill() {},
    events: (async function* (): AsyncGenerator<AgentEvent> { yield { kind: "done", exitStatus: 1 }; })(),
  };
};
for (const executor of [ClaudeExecutor.prototype, CodexExecutor.prototype]) {
  executor.run = run;
  executor.runSteerable = run;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  assert.fail(message);
};
const intentsOf = async (queueId: string) =>
  db.select().from(queueAdvanceIntents).where(eq(queueAdvanceIntents.queueId, queueId));
const taskRow = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;

/** 单成员队列的队首:正在跑,这一轮写下了续跑交代。占着锁落 paused,返回锁的身份。 */
async function pausedHeadUnderLock(id: string, queueId: string, prompt: string) {
  const at = new Date().toISOString();
  await createTasks([{
    id, projectId: "p", title: id, body: "test", mode: "single", status: "running",
    agentType: "codex", executorId: "ex", autoTitle: false, workflowMode: "free",
    useWorktree: false, resumePrompt: prompt, createdAt: at, updatedAt: at,
  }]);
  await db.insert(queueItems).values({ taskId: id, queueId, position: 0, createdAt: at });
  const turn = claimOwnTurn(id, "single");
  assert.ok(turn, "测试自身前提:这一轮应该占得到锁");
  await setTaskStatus(id, "paused");
  assert.equal((await taskRow(id)).status, "paused");
  return turn;
}

let failure: unknown = null;
try {
  if (phase === "seed") {
    // `setTaskStatus` 一返回就退出,不放锁、不等任何后台写:回合收尾到一半服务被重启。
    await pausedHeadUnderLock("restart-head", "q-restart", "RESTART-CHECKPOINT-CONTINUE");
    process.exit(0);
  } else {
    const at = new Date().toISOString();
    await db.insert(projects).values({ id: "p", name: "release restart", repoPath: root, createdAt: at });
    await db.insert(agents).values({ id: "ex", name: "test", type: "codex", model: "test", isDefault: true });

    // ── 一、收尾到一半重启 ─────────────────────────────────────────────────────────
    const seeded = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "seed"], {
      env: { ...process.env, RESTART_ROOT: root }, stdio: "inherit",
    });
    assert.equal(seeded.status, 0, "子进程(重启前的那个服务)没有跑完");
    assert.equal((await taskRow("restart-head")).status, "paused");
    assert.equal((await intentsOf("q-restart")).length, 1,
      "状态已经落了 paused,推进意图就必须已经在库里 —— 两者之间不许有能崩进去的缝");
    const { reconcileInterrupted } = await import("../src/task-reconcile.js");
    const { recoverQueueAdvances } = await import("../src/scheduler.js");
    await reconcileInterrupted();
    await recoverQueueAdvances();
    await waitFor(() => launched.some((prompt) => prompt.includes("RESTART-CHECKPOINT-CONTINUE")),
      "重启之后队首没被叫起来续跑 —— 推进责任跟着进程一起没了,整条队列停住");
    await waitFor(async () => !isTurnClaimed("restart-head") && (await taskRow("restart-head")).status !== "running",
      "续跑那一轮没有结算");
    assert.equal(launched.length, 1, "重启后只续跑一次");
    console.log("✓ 状态已落 paused、锁还没放时重启:推进意图已在库里,开机恢复照样把队首叫起来续跑");

    // ── 二、正常放锁 ───────────────────────────────────────────────────────────────
    const turn = await pausedHeadUnderLock("release-head", "q-release", "RELEASE-CHECKPOINT-CONTINUE");
    await waitFor(async () => (await intentsOf("q-release")).length === 1, "锁还占着时推进意图就该落库");
    await sleep(300);
    assert.equal(launched.length, 1, "锁还占着,不许推进");
    releaseTurn("release-head", turn);
    await waitFor(() => launched.some((prompt) => prompt.includes("RELEASE-CHECKPOINT-CONTINUE")),
      "放锁那一刻队首该被叫起来续跑");
    await waitFor(async () => !isTurnClaimed("release-head") && (await taskRow("release-head")).status !== "running",
      "续跑那一轮没有结算");
    await waitFor(async () => (await intentsOf("q-release")).length === 0,
      "放锁那一刻推进做完之后,先落的那一份推进意图该被了结 —— 留着它,下一次重启会平白再推一遍");
    assert.equal(launched.length, 2);
    console.log("✓ 正常放锁:放锁那一刻推进,做完不留多余的推进意图");

    // ── 三、事务里查队列失败 ─────────────────────────────────────────────────────────
    // 只打状态事务里那一下查 queue_items:注入一次失败,随即恢复。
    const realTransaction = db.transaction.bind(db);
    let failLookups = 1;
    (db as { transaction: unknown }).transaction = (run: (tx: unknown) => Promise<unknown>, config?: unknown) =>
      realTransaction(async (tx) => run(new Proxy(tx, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (key !== "select" || failLookups <= 0) return typeof value === "function" ? value.bind(target) : value;
          return () => { failLookups--; throw new Error("SQLITE_BUSY: 测试注入一次队列查询失败"); };
        },
      })), config as never);
    const lookupAt = new Date().toISOString();
    await createTasks([{
      id: "lookup-head", projectId: "p", title: "lookup-head", body: "test", mode: "single", status: "running",
      agentType: "codex", executorId: "ex", autoTitle: false, workflowMode: "free",
      useWorktree: false, resumePrompt: "LOOKUP-CHECKPOINT-CONTINUE", createdAt: lookupAt, updatedAt: lookupAt,
    }]);
    await db.insert(queueItems).values({ taskId: "lookup-head", queueId: "q-lookup", position: 0, createdAt: lookupAt });
    const lookupTurn = claimOwnTurn("lookup-head", "single");
    assert.ok(lookupTurn);
    await assert.rejects(setTaskStatus("lookup-head", "paused"), /测试注入/,
      "查不到队列不许被当成「不在队列」:状态那一笔要整笔失败,交给调用方重试");
    assert.equal(failLookups, 0, "测试自身前提:注入点确实打中了状态事务里的那一下查询");
    assert.equal((await taskRow("lookup-head")).status, "running", "整笔回滚:状态没有变");
    assert.equal((await intentsOf("q-lookup")).length, 0);
    (db as { transaction: unknown }).transaction = realTransaction;
    assert.equal(await setTaskStatus("lookup-head", "paused"), true, "库恢复之后重试一次照常落库");
    assert.equal((await intentsOf("q-lookup")).length, 1, "重试那一笔带着推进凭据一起落库");
    releaseTurn("lookup-head", lookupTurn);
    await waitFor(() => launched.some((prompt) => prompt.includes("LOOKUP-CHECKPOINT-CONTINUE")),
      "查询失败恢复之后,放锁那一刻队首该被叫起来续跑");
    await waitFor(async () => !isTurnClaimed("lookup-head") && (await taskRow("lookup-head")).status !== "running",
      "续跑那一轮没有结算");
    assert.equal(launched.length, 3);
    console.log("✓ 状态事务里查队列失败:整笔不落、不把「查不到」当「不在队列」,重试后照常推进");
  }
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  await releaseTmpDb();
  if (phase === "main") rmSync(root, { recursive: true, force: true });
  process.exit(failure ? 1 : 0);
}
