// 接管之外的另一半：结论**已经有了**，ash 却在把它办完之前死掉（第 1 轮审查 F1/F2/F3）。
//  F1  停机期间越过了时限：命令在 ash 不在场时 rc=0 退出，但已经跑过上限 —— 照样按超时收，
//      不能因为 ash 当时不在就把一个超时的结果当成通过合进去；
//  F2  结算到一半（结论已认领、进程已收、终态还没落）死掉：新实例照认领下来的那一份收完，
//      不改判成「被打断」；
//  F3  终态落了、续验收 / 交修还没办就死掉：新实例补办，绿了照常合并、红了照常交回，
//      并且只补一次。
//
// 「死掉」同 test-accept-gate-takeover.ts：另一个进程（accept-gate-crash-worker.ts）发起验收，
// 在指定那一句 SQL 前后 SIGKILL 自己。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { acceptGateRuns, sessions, tasks } from "../src/db/schema.js";
import { recoverAcceptGates } from "../src/accept-gate.js";
import { gateExitPath, readGateLaunch } from "../src/accept-gate-launch.js";
import { gateExitOutcome } from "../src/accept-gate-exit.js";
import { overrideGateWatchTimings } from "../src/accept-gate-watch.js";
import { sessionTranscriptPath } from "../src/transcript.js";
import { isTurnClaimed, releaseTurn } from "../src/turn-lock.js";
import type { GateFixture } from "./test-accept-gate-lifecycle.js";

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate: () => boolean | Promise<boolean>, what: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`takeover settle: ${what} timed out`);
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const read = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : "";

export async function testGateTakeoverSettle(fixture: GateFixture): Promise<void> {
  const { root, makeRepo, seedProject, seedTask, taskRow, settled } = fixture;
  const runOf = async (taskId: string) => (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId)))[0]!;
  const main = (repo: string) => execFileSync("git", ["-C", repo, "rev-parse", "main"], { encoding: "utf8" }).trim();
  const crashWorker = fileURLToPath(new URL("./accept-gate-crash-worker.ts", import.meta.url));

  async function stage(name: string) {
    const repo = makeRepo(`takeover-settle-${name}`);
    const taskId = `gate-takeover-settle-${name}`;
    const release = join(root, `takeover-settle-${name}.release`);
    const command = `while [ ! -f '${release}' ]; do sleep 0.05; done; exit $(cat '${release}')`;
    const projectId = await seedProject(taskId, repo, command);
    await seedTask(projectId, repo, taskId, `${name}.txt`);
    const sessionId = `${taskId}-session`;
    const at = new Date().toISOString();
    await db.insert(sessions).values({ id: sessionId, taskId, role: "single", agentType: "claude", executor: "claude",
      cwd: repo, startedAt: at, turnStartedAt: at, endedAt: at, activeMs: 0 });
    return { repo, taskId, release, before: main(repo), timeline: () => read(sessionTranscriptPath(taskId, sessionId)) };
  }

  /**
   * 旧 ash 发起验收；`phase` 决定它死在哪：armed = 命令放行之后立刻死；before-final / after-final =
   * 活着等命令按 `code` 退出、自己去结算，死在终态那一句之前 / 之后。
   */
  async function crash(s: Awaited<ReturnType<typeof stage>>, phase: "armed" | "before-final" | "after-final", code?: string) {
    const worker = spawn(process.execPath, ["--import", "tsx", crashWorker, s.taskId, phase],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let diagnostic = "";
    worker.stderr?.on("data", chunk => { diagnostic += String(chunk); });
    const exited = new Promise<string | null>((resolve, reject) => {
      const timeout = setTimeout(() => { worker.kill("SIGKILL"); reject(new Error(diagnostic || "crash worker timed out")); }, 30_000);
      worker.once("error", reject);
      worker.once("exit", (_code, exitSignal) => { clearTimeout(timeout); resolve(exitSignal); });
    });
    if (code !== undefined) {
      await until(async () => {
        const row = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, s.taskId))).at(0);
        return !!row && readGateLaunch(row.logPath)?.phase === "armed";
      }, "命令放行");
      writeFileSync(s.release, code);
    }
    assert.equal(await exited, "SIGKILL", diagnostic);
    return runOf(s.taskId);
  }

  /** 红了交回之后，那条修复会话由测试替它收掉，别留一个在跑的回合。 */
  async function drainHandoff(taskId: string) {
    await until(async () => (await db.select().from(sessions).where(eq(sessions.taskId, taskId))).length > 1, "交回任务去修");
    for (let i = 0; i < 200 && (await taskRow(taskId)).status !== "running"; i++) await sleep(25);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, taskId));
    releaseTurn(taskId);
    // 那个回合收尾时还要写库：等它真的结束，别让它撞上测试末尾已关的库。
    await until(async () => (await db.select().from(sessions).where(eq(sessions.taskId, taskId))).every(row => row.endedAt),
      "修复回合收尾");
    await sleep(300);
  }

  // 判据本身：同一份退出，用时在期限内就看 rc，过了期限一律超时 —— 不看那一刻谁在场。
  assert.deepEqual(gateExitOutcome({ code: 0, signal: null, elapsedMs: 2_999 }, 3_000),
    { status: "passed", exitCode: 0, failure: null });
  assert.equal(gateExitOutcome({ code: 0, signal: null, elapsedMs: 3_000 }, 3_000).failure, "timeout");
  assert.equal(gateExitOutcome({ code: 3, signal: null, elapsedMs: 9_000 }, 3_000).exitCode, null, "过了时限的退出码不作数");

  // F1：ash 不在场的时候命令越过了时限才 rc=0 退出 → 超时，不合并。
  {
    const s = await stage("deadline");
    const row = await crash(s, "armed");
    const limit = 2_000;
    await until(() => Date.now() - Date.parse(row.startedAt) > limit + 300, "跑过时限", limit + 5_000);
    writeFileSync(s.release, "0");
    await until(() => existsSync(gateExitPath(row.logPath)) && !alive(row.pid!), "命令跑完");
    overrideGateWatchTimings({ timeoutMs: limit });
    try {
      assert.equal((await recoverAcceptGates()).settled, 1);
      await settled(s.taskId);
    } finally { overrideGateWatchTimings(null); }
    const done = await runOf(s.taskId);
    assert.equal(done.status, "failed");
    assert.equal(done.failure, "timeout");
    assert.equal(done.exitCode, null);
    assert.equal(main(s.repo), s.before, "超时的绿不能合进去");
    assert.match(s.timeline(), /超过了 .* 分钟的上限，按超时处理/);
    for (let i = 0; i < 200 && isTurnClaimed(s.taskId); i++) await sleep(25);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, s.taskId));
    releaseTurn(s.taskId);
  }

  // F2：结论已认领、进程已收（abort 已写），终态还没落就死了 → 照认领的那一份收完，绿了合并。
  {
    const s = await stage("mid-settle");
    const row = await crash(s, "before-final", "0");
    assert.equal(row.status, "running");
    assert.ok(row.settlement, "结论在动刀之前就落了库");
    assert.equal(JSON.parse(row.settlement!).status, "passed");
    const recovered = await recoverAcceptGates();
    assert.deepEqual(recovered, { interrupted: 0, resumed: 0, settled: 1 });
    await settled(s.taskId);
    const done = await runOf(s.taskId);
    assert.equal(done.status, "passed", "已经观察到的结论不能被改判成被打断");
    assert.equal(done.processPending, false);
    assert.equal(done.settlement, null, "续验收办完才清掉记号");
    assert.equal((await taskRow(s.taskId)).stage, "accepted");
    assert.notEqual(main(s.repo), s.before);
    assert.match(s.timeline(), /正在收尾，结论已经落库，按那一份接着收完/);
  }

  // F3（绿）：终态 passed 已落、自动续验收还没办 → 补办合并，且只补一次。
  {
    const s = await stage("owed-pass");
    const row = await crash(s, "after-final", "0");
    assert.equal(row.status, "passed");
    assert.ok(row.settlement, "欠着续验收的记号还在");
    assert.equal((await taskRow(s.taskId)).stage, "verified", "死在合并之前");
    assert.equal(main(s.repo), s.before);
    assert.deepEqual(await recoverAcceptGates(), { interrupted: 0, resumed: 0, settled: 0 }, "补办不算新结算");
    await settled(s.taskId);
    assert.equal((await taskRow(s.taskId)).stage, "accepted", "重启后补上那一次自动合并");
    const merged = main(s.repo);
    assert.notEqual(merged, s.before);
    assert.equal((await runOf(s.taskId)).settlement, null);
    assert.match(s.timeline(), /已经通过，但随后的自动验收还没办完，现在补上/);
    await recoverAcceptGates();
    await settled(s.taskId);
    assert.equal(main(s.repo), merged, "再重启一次也不会补第二遍");
  }

  // F3（红）：终态 failed 已落、交回修复还没发 → 补发交接。
  {
    const s = await stage("owed-fail");
    const row = await crash(s, "after-final", "3");
    assert.equal(row.status, "failed");
    assert.equal(row.exitCode, 3);
    assert.ok(row.settlement);
    assert.equal(row.handoffAt, null, "死在交接之前");
    await recoverAcceptGates();
    await settled(s.taskId);
    await drainHandoff(s.taskId);
    const done = await runOf(s.taskId);
    assert.ok(done.handoffAt, "重启后补上交回修复");
    assert.equal(done.settlement, null);
    assert.equal(main(s.repo), s.before);
    assert.match(s.timeline(), /已经红了，但随后的交回修复还没办完，现在补上/);
  }
  console.log("accept gate takeover settle: 停机越过时限按超时 / 收尾中途崩溃照认领结论收完 / 终态后崩溃补办合并且只补一次 / 补办交回修复 passed");
}
