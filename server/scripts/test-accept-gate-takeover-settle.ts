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
import { db, dbClient } from "../src/db/index.js";
import { acceptGateRuns, sessions, tasks } from "../src/db/schema.js";
import { recoverAcceptGates } from "../src/accept-gate.js";
import { collectGateRuns } from "../src/handoff-accept-gate.js";
import { gateExitPath, readGateLaunch } from "../src/accept-gate-launch.js";
import { gateExitOutcome } from "../src/accept-gate-exit.js";
import { overrideGateWatchTimings } from "../src/accept-gate-watch.js";
import { sessionTranscriptPath } from "../src/transcript.js";
import { makeStep } from "@ash/shared/workflow";
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
  async function crash(s: Awaited<ReturnType<typeof stage>>,
    phase: "armed" | "before-final" | "after-final" | "after-merged" | "after-handoff-mark" | "after-tail-mark"
      | "before-delivered-clear" | "after-delivery-claim", code?: string) {
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
  // ——以下是续办**开始之后**的三个窗口（第 2 轮审查）：中间态、读失败都不能当成办完了。

  // 合并已经提交、清理和最终验收还没做 → 不是办完：补办走 acceptTask 自己的 merged 续做路径收完。
  {
    const s = await stage("owed-merged");
    const row = await crash(s, "after-merged", "0");
    const half = await taskRow(s.taskId);
    assert.equal(half.stage, "merged");
    assert.equal(half.acceptedGateRunId, row.id, "凭据已经写下，但这不是验收完成的证明");
    assert.notEqual(main(s.repo), s.before, "目标分支已经真的动了");
    assert.ok(row.settlement);
    await recoverAcceptGates();
    await settled(s.taskId);
    assert.equal((await taskRow(s.taskId)).stage, "accepted", "重启后把清理和最终验收做完");
    assert.equal((await runOf(s.taskId)).settlement, null);
  }

  // 记下了 handoff_at、修复输入一个字都没送出去 → 不是办完：补发一次。
  {
    const s = await stage("owed-mark");
    const row = await crash(s, "after-handoff-mark", "3");
    assert.ok(row.handoffAt, "「发起过」已经落盘");
    assert.ok(row.settlement, "送达之前记号不清");
    assert.equal((await db.select().from(sessions).where(eq(sessions.taskId, s.taskId))).length, 1, "一个字都没送出去");
    await recoverAcceptGates();
    await settled(s.taskId);
    await drainHandoff(s.taskId);
    assert.equal((await runOf(s.taskId)).settlement, null, "送达之后才销账");
    assert.match(s.timeline(), /已经红了，但随后的交回修复还没办完，现在补上/);
  }

  // 补办第一次读库就临时失败 → 记号留着；故障消失后下一次启动照样补上。
  {
    const s = await stage("owed-flaky");
    const row = await crash(s, "after-final", "0");
    assert.ok(row.settlement);
    const execute = dbClient.execute.bind(dbClient);
    let failures = 0;
    Object.defineProperty(dbClient, "execute", { configurable: true, writable: true, value: async (...args: Parameters<typeof execute>) => {
      const sql = typeof args[0] === "string" ? args[0] : (args[0] as { sql?: string }).sql ?? "";
      if (failures === 0 && /^select .* from "tasks"/i.test(sql) && JSON.stringify(args).includes(s.taskId)) {
        failures++;
        throw new Error("temporary follow-up read failure");
      }
      return execute(...args);
    } });
    try {
      await recoverAcceptGates();
      await settled(s.taskId);
    } finally { Object.defineProperty(dbClient, "execute", { configurable: true, writable: true, value: execute }); }
    assert.equal(failures, 1);
    assert.equal((await taskRow(s.taskId)).stage, "verified");
    assert.ok((await runOf(s.taskId)).settlement, "读失败不是办完：记号留给下次启动");
    await recoverAcceptGates();
    await settled(s.taskId);
    assert.equal((await taskRow(s.taskId)).stage, "accepted", "故障消失后补上合并");
    assert.equal((await runOf(s.taskId)).settlement, null);
  }

  // 欠着后续的那一行不许跨机接力带走（带走了这份责任就丢在两台机器之间）。
  {
    const s = await stage("owed-relay");
    const row = await crash(s, "after-final", "0");
    assert.ok(row.settlement);
    await assert.rejects(collectGateRuns(s.taskId), /办完后才能接力/);
    await recoverAcceptGates();
    await settled(s.taskId);
    assert.equal((await collectGateRuns(s.taskId)).length, 1, "办完就能接力");
  }
  // ——第 3 轮审查：「走完了」要有证据，「送到了」要有证据。

  /** 这次运行的修复输入作为用户回合在会话里出现了几次（时间线旁注里也有日志路径，不算）。 */
  async function deliveries(taskId: string, logPath: string): Promise<number> {
    let count = 0;
    for (const { id } of await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.taskId, taskId))) {
      for (const chunk of read(sessionTranscriptPath(taskId, id)).split("\x1e")) {
        try {
          const turn = JSON.parse(chunk.split("\n")[0]!) as { t?: string; text?: string };
          if (turn.t === "user" && turn.text?.includes(logPath)) count++;
        } catch { /* 不是回合记录 */ }
      }
    }
    return count;
  }

  // 续验收内部第一次读项目临时失败（acceptTask 抛出来了）→ 不是「验收没过」的结果：记号留着，下次补上。
  {
    const s = await stage("owed-inner");
    const row = await crash(s, "after-final", "0");
    assert.ok(row.settlement);
    const execute = dbClient.execute.bind(dbClient);
    let failures = 0;
    Object.defineProperty(dbClient, "execute", { configurable: true, writable: true, value: async (...args: Parameters<typeof execute>) => {
      const sql = typeof args[0] === "string" ? args[0] : (args[0] as { sql?: string }).sql ?? "";
      if (failures === 0 && /^select .* from "projects"/i.test(sql) && JSON.stringify(args).includes(`gate-project-${s.taskId}`)) {
        failures++;
        throw new Error("temporary project read failure");
      }
      return execute(...args);
    } });
    try {
      await recoverAcceptGates();
      await settled(s.taskId);
    } finally { Object.defineProperty(dbClient, "execute", { configurable: true, writable: true, value: execute }); }
    assert.equal(failures, 1, "故障打在了续验收内部");
    assert.equal((await taskRow(s.taskId)).stage, "verified");
    assert.ok((await runOf(s.taskId)).settlement, "抛出来的异常不是结果：记号留着");
    assert.match(s.timeline(), /自动继续验收时出错.*这一步还欠着/);
    await recoverAcceptGates();
    await settled(s.taskId);
    assert.equal((await taskRow(s.taskId)).stage, "accepted", "故障消失后补上合并");
    assert.equal((await runOf(s.taskId)).settlement, null);
  }

  // accepted 已落、「点头之后」的发布命令还没跑就崩溃 → accepted 不是走完的证明：补跑尾段。
  {
    const s = await stage("owed-tail");
    const marker = join(root, "takeover-settle-owed-tail.published");
    const script = join(root, "takeover-settle-owed-tail.cjs");
    writeFileSync(script, `require("fs").appendFileSync(${JSON.stringify(marker)}, "1");`);
    const accept = makeStep("accept", "accept");
    if (accept.kind === "accept") accept.p = { strategy: "safe", clean: "none" };
    const publish = makeStep("command", "after-accept");
    if (publish.kind === "command") publish.p = { cmd: `"${process.execPath}" "${script}"`, where: "repo" };
    await db.update(tasks).set({ workflowAt: "gate", workflow: JSON.stringify({ workspace: "isolated",
      steps: [makeStep("run", "run"), makeStep("human", "gate"), accept, publish] }) }).where(eq(tasks.id, s.taskId));
    const row = await crash(s, "after-tail-mark", "0");
    const half = await taskRow(s.taskId);
    assert.equal(half.stage, "accepted");
    assert.equal(half.acceptedTailPending, true);
    assert.equal(existsSync(marker), false, "发布命令还没跑");
    assert.ok(row.settlement);
    await recoverAcceptGates();
    await settled(s.taskId);
    assert.equal(read(marker), "1", "重启后补跑那一次从没发生过的发布，只跑一次");
    assert.equal((await taskRow(s.taskId)).acceptedTailPending, false);
    assert.equal((await runOf(s.taskId)).settlement, null);
  }

  // 修复输入已经落进会话、回执到了、记号还没清就崩溃 → 不重发。
  {
    const s = await stage("owed-delivered");
    const row = await crash(s, "before-delivered-clear", "3");
    assert.equal(JSON.parse(row.settlement!).delivering, true, "起跑前记下了「开始投递」");
    await until(async () => await deliveries(s.taskId, row.logPath) === 1, "原话落盘");
    const sessionsBefore = (await db.select().from(sessions).where(eq(sessions.taskId, s.taskId))).length;
    await recoverAcceptGates();
    await settled(s.taskId);
    await sleep(500);
    assert.equal(await deliveries(s.taskId, row.logPath), 1, "同一次失败只交一遍");
    assert.equal((await db.select().from(sessions).where(eq(sessions.taskId, s.taskId))).length, sessionsBefore);
    const done = await runOf(s.taskId);
    assert.equal(done.settlement, null);
    assert.equal(done.handoffError, null, "有送达证据就是送到了，不报「说不清」");
    // 那一轮是死掉的旧进程起的，没人替它收口：测试替它落终态，别留一个挂着的回合。
    await db.update(sessions).set({ endedAt: new Date().toISOString() }).where(eq(sessions.taskId, s.taskId));
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, s.taskId));
    releaseTurn(s.taskId);
  }

  // 记下「开始投递」、还没起跑就崩溃 → 说不清有没有送到：不重发，如实记一笔，出路交给用户。
  {
    const s = await stage("owed-uncertain");
    const row = await crash(s, "after-delivery-claim", "3");
    assert.equal(JSON.parse(row.settlement!).delivering, true);
    await recoverAcceptGates();
    await settled(s.taskId);
    await sleep(500);
    assert.equal(await deliveries(s.taskId, row.logPath), 0, "不自动重发");
    const done = await runOf(s.taskId);
    assert.equal(done.settlement, null);
    assert.match(done.handoffError ?? "", /说不清有没有送到/);
    assert.match(s.timeline(), /点「再交一次」/);
  }
  console.log("accept gate takeover settle: 停机越过时限按超时 / 收尾中途崩溃照认领结论收完 / 终态后崩溃补办合并且只补一次 / 补办交回修复 / 合并后清理前崩溃续完验收 / 记了交接时间未送达补发 / 补办读失败不销账 / 欠后续不许接力 / 续验收内部异常不销账 / 尾段未跑补跑 / 已送达不重发 / 说不清不重发 passed");
}
