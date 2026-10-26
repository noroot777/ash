// 门禁被收掉时**说不说得清卡在哪**的回归。
//
// 钉住的那件事（用户 2026-10-26）：一次跑满 90 分钟的门禁，日志里只有一句「超过 90 分钟，
// 按超时处理」—— 看不出停在哪一条、静了多久，于是分不出是某一步卡住还是整台机器在爬。
// 下面三组用例分别钉住：
//  ① 静默被收：结论里有「停在哪一行」和「静了多久」，而且判词说的是「某一步卡住」；
//  ② 一直在出东西却撞上限：同样两个信息，但判词说的是「整条命令在爬」；
//  ③ 走完整条验收链路（真起进程、真结算、真写时间线）时，这两个信息确实落到了
//     日志末尾和任务时间线上 —— 写在日志中间的结论会被测试输出冲掉，等于没写。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-gate-watch-"));
process.env.ASH_DB = join(root, "ash.db");
// RUNS_DIR 指到临时目录顺带打开 guardAgentSpawn：门禁红了会**真的发起一轮**去叫醒 agent，
// 拦截器保证那一轮不会起真 CLI。
process.env.ASH_RUNS_DIR = join(root, "runs");
assert.notEqual(process.env.ASH_ALLOW_REAL_AGENT, "1", "门禁红了会叫醒任务，拦截器一失效就会烧真额度");

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * 等一个结论。看门狗的定时器是 `unref` 的（ash 不该被它吊着不退），所以在只有它一个
 * 待办事项的测试进程里，Node 会直接退出 —— 这里自己撑一根活的定时器把事件循环留住。
 */
async function awaitVerdict(start: (resolve: (verdict: { failure: string; note: string }) => void) => void) {
  const keepAlive = setInterval(() => {}, 20);
  try { return await new Promise<{ failure: string; note: string }>(start); }
  finally { clearInterval(keepAlive); }
}

try {
  const { gateWatchReport, overrideGateWatchTimings, startGateWatch } = await import("../src/accept-gate-watch.js");

  // ① 静默：命令打完一行就再也不出声，而我们自己的进度行一直在往日志里写。
  {
    const logPath = join(root, "stalled.log");
    writeFileSync(logPath, "> @ash/web@0.0.0 test:system-notices-dom\nsystem-notices-dom ok\n", "utf8");
    overrideGateWatchTimings({ silenceMs: 400, progressMs: 80, sampleMs: 20, timeoutMs: 60_000 });
    const verdict = await awaitVerdict((resolve) => { startGateWatch({ logPath, onVerdict: resolve }); });
    const log = readFileSync(logPath, "utf8");
    assert.equal(verdict.failure, "stalled", "日志连着不长就该当场判卡住，不必等满上限");
    // 这一条是整个修复的要害：进度行自己也会把日志撑大，不把它从账上扣掉就永远判不出静默。
    assert.match(log, /\[ash\] 进度 · 开跑后 /, "进度行要真的落进日志，不然事后没有时间轴");
    assert.match(log, /停在这一行：`system-notices-dom ok`/, "「停在哪一行」不能指向我们自己的进度行");
    assert.match(log, /最后一次有输出在 \d+\.\d 分钟前/, "「静了多久」要给得出数");
    assert.match(log, /产出节奏（开跑第几分钟 \/ 累计输出）：\d/, "要留下节奏，才看得出是一直慢还是中途卡住");
    assert.match(log, /判断：连续 \d+\.\d 分钟零输出 —— 是\*\*某一步卡住了\*\*/, "结论必须当场判死，不能让人自己猜");
    assert.match(verdict.note, /停在 `system-notices-dom ok` 之后连续 \d+\.\d 分钟没有任何输出/, "一句话版本也要带齐这两条");
  }

  // ② 一直在出东西却撞上限：同样两条信息，但结论反过来 —— 是在爬，不是卡死。
  {
    const logPath = join(root, "crawling.log");
    writeFileSync(logPath, "", "utf8");
    overrideGateWatchTimings({ silenceMs: 60_000, progressMs: 80, sampleMs: 20, timeoutMs: 500 });
    let tick = 0;
    const writer = setInterval(() => appendFileSync(logPath, `crawling step ${tick++} ok\n`, "utf8"), 25);
    const verdict = await awaitVerdict((resolve) => { startGateWatch({ logPath, onVerdict: resolve }); });
    clearInterval(writer);
    const log = readFileSync(logPath, "utf8");
    assert.equal(verdict.failure, "timeout");
    assert.match(log, /停在这一行：`crawling step \d+ ok`/);
    assert.match(log, /判断：直到被收掉都还在出东西.+\*\*整条命令在爬\*\*/s, "还在持续产出就不能说成卡死");
    assert.doesNotMatch(verdict.note, /某一步卡住/);
  }

  // ③ `stop()` 之后不该再有结论：命令自己退出、或被取消时走的就是这一条。
  {
    const logPath = join(root, "stopped.log");
    writeFileSync(logPath, "quiet\n", "utf8");
    overrideGateWatchTimings({ silenceMs: 50, progressMs: 1_000, sampleMs: 10, timeoutMs: 60_000 });
    let fired = false;
    startGateWatch({ logPath, onVerdict: () => { fired = true; } }).stop();
    await sleep(200);
    assert.equal(fired, false, "撤掉的看门狗不许再叫，否则会把一条已经收好的门禁再收一遍");
  }

  // ④ 措辞本身是纯函数，边界单独钉一下：没有任何输出时不能印出一个空的反引号。
  {
    const blank = gateWatchReport({ failure: "stalled", elapsedMs: 90 * 60_000, silentMs: 90 * 60_000,
      limitMs: 20 * 60_000, lastLine: null, bytes: 0, marks: [] });
    assert.match(blank.log, /停在这一行：（日志里没有命令自己的输出）/);
    assert.match(blank.log, /产出节奏（开跑第几分钟 \/ 累计输出）：（没跑够一个采样间隔）/);
  }

  // ⑤ 整条链路：真起一条只打一行就装死的命令，看现场有没有落到日志末尾和任务时间线上。
  {
    overrideGateWatchTimings({ silenceMs: 700, progressMs: 200, sampleMs: 40, timeoutMs: 120_000 });
    const repo = join(root, "repo");
    execFileSync("git", ["init", "-b", "main", repo]);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
    git("config", "user.name", "Gate Watch Test");
    git("config", "user.email", "gate@example.test");
    writeFileSync(join(repo, "seed.txt"), "seed");
    git("add", "-A");
    git("commit", "-m", "seed");

    const { db, ensureSchema } = await import("../src/db/index.js");
    const { acceptGateRuns, projects, sessions, tasks } = await import("../src/db/schema.js");
    const { acceptTask } = await import("../src/task-accept.js");
    const { cancelAcceptGate, whenAcceptGateSettled } = await import("../src/accept-gate.js");
    const { sessionTranscriptPath } = await import("../src/transcript.js");
    const { isTurnClaimed } = await import("../src/turn-lock.js");
    await ensureSchema();

    const taskId = "gate-watch-task";
    const stamp = new Date().toISOString();
    await db.insert(projects).values({ id: "gate-watch-project", name: "watch", repoPath: repo,
      acceptGateCommand: `"${process.execPath}" -e "console.log('GATE_STEP ok'); setTimeout(()=>{}, 600000)"`,
      createdAt: stamp });
    await db.insert(tasks).values({ id: taskId, projectId: "gate-watch-project", title: "watch", status: "done",
      stage: "verified", workflowMode: "free", mode: "single", useWorktree: false, createdAt: stamp, updatedAt: stamp });
    await db.insert(sessions).values({ id: "gate-watch-session", taskId, role: "single", agentType: "codex",
      executor: "codex", cwd: repo, startedAt: stamp, turnStartedAt: stamp, endedAt: stamp, activeMs: 0 });

    const first = await acceptTask(taskId);
    assert.equal(first.accepted, false, "设了门禁的第一按只登记、不合并");
    const runOf = async () => (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId))).at(0);
    let run = await runOf();
    for (let i = 0; i < 400 && (!run || run.status === "running"); i++) { await sleep(25); run = await runOf(); }
    assert.ok(run, "门禁没有登记");
    try {
      assert.equal(run.status, "failed");
      assert.equal(run.failure, "stalled", "装死的命令要在静默线上被收掉，而不是白等满上限");
      await whenAcceptGateSettled(run.id);

      const log = readFileSync(run.logPath, "utf8");
      assert.match(log, /被收掉时的现场/);
      assert.match(log, /停在这一行：`GATE_STEP ok`/, "停在哪一行要指向命令自己的输出");
      // 现场必须在**末尾**：回显给界面和 agent 的只有最后 ACCEPT_GATE_TAIL_BYTES 个字节。
      const { acceptGateLogTail } = await import("../src/accept-gate-process.js");
      const tail = acceptGateLogTail(run.logPath);
      assert.match(tail, /停在这一行：`GATE_STEP ok`/, "写在日志中间的结论会被测试输出冲掉");
      assert.match(tail, /最后一次有输出在 \d+\.\d 分钟前/);

      const transcript = (await db.select().from(sessions).where(eq(sessions.taskId, taskId)))
        .map((row) => { try { return readFileSync(sessionTranscriptPath(taskId, row.id), "utf8"); } catch { return ""; } })
        .join("\n");
      assert.match(transcript, /卡住了/, "时间线上要留下「这一次是卡住的」，刷新后仍看得见");
      assert.match(transcript, /停在 `GATE_STEP ok` 之后连续 \d+\.\d 分钟没有任何输出/,
        "不点开日志也要知道停在哪、静了多久");
    } finally {
      await cancelAcceptGate(taskId).catch(() => {});
      // 红了会真的发起一轮去叫醒 agent（拦截器挡住了真 CLI）。那一轮的收尾是异步的，
      // 不等它落地就关库，剩下的回调会刷一屏 "database is not open"。
      for (let i = 0; i < 200 && isTurnClaimed(taskId); i++) await sleep(25);
      await sleep(200);
    }
  }

  overrideGateWatchTimings(null);
  console.log("✅ 门禁看门狗：静默判死 / 在爬判慢 / 现场落在日志末尾与任务时间线 通过");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
