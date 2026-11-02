// ash 在门禁跑着的时候死掉，新实例起来之后的四条分流（server/src/accept-gate-exit.ts 顶部）：
//  (a) 命令还在跑 → 接管：看门的重挂、时限从开跑那一刻算，最后按真实 rc 结算；
//  (b) 已经 rc=0 退出 → 结算 passed，并照常自动把验收做完；
//  (c) 已经 rc≠0 退出 → 结算 failed，照常交回任务去修；
//  (d) 没有退出档 → 维持老结局「被打断」，文案不变。
// 外加身份核验：pid 被复用时绝不接管、绝不误杀、绝不拿别人的退出结算。
//
// 「ash 死掉」是真的：门禁由另一个进程（accept-gate-crash-worker.ts）发起，命令放行后它
// SIGKILL 自己，内存里的退出回调、看门的、进程表全部跟着没了，本进程只剩库和盘上的文件。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { acceptGateRuns, sessions, tasks } from "../src/db/schema.js";
import { acceptTask } from "../src/task-accept.js";
import { acceptGateState, forceReleaseAcceptGate, hasLiveAcceptGate, recoverAcceptGates } from "../src/accept-gate.js";
import { gateAbortPath, gateExitPath, gateGoPath, prepareGateLaunch, readGateLaunch, writeGateLaunch } from "../src/accept-gate-launch.js";
import { gateRecoveryFate, watchGateExit } from "../src/accept-gate-exit.js";
import { gateNotesPath } from "../src/accept-gate-diagnosis.js";
import { overrideGateWatchTimings } from "../src/accept-gate-watch.js";
import { sessionTranscriptPath } from "../src/transcript.js";
import { isTurnClaimed, releaseTurn } from "../src/turn-lock.js";
import { inspectProcessSync } from "../src/platform.js";
import type { GateExit } from "../src/accept-gate-process.js";
import type { GateFixture } from "./test-accept-gate-lifecycle.js";

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate: () => boolean | Promise<boolean>, what: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`takeover: ${what} timed out`);
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const read = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : "";

export async function testGateTakeover(fixture: GateFixture): Promise<void> {
  const { root, makeRepo, seedProject, seedTask, taskRow, settled } = fixture;
  const runOf = async (taskId: string) => (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId)))[0]!;
  const main = (repo: string) => execFileSync("git", ["-C", repo, "rev-parse", "main"], { encoding: "utf8" }).trim();
  const crashWorker = fileURLToPath(new URL("./accept-gate-crash-worker.ts", import.meta.url));

  /** 一个任务 + 一条会话（时间线写在会话里），命令等 release 文件出现后按里面的数退出。 */
  async function stage(name: string, prelude = "") {
    const repo = makeRepo(`takeover-${name}`);
    const taskId = `gate-takeover-${name}`;
    const release = join(root, `takeover-${name}.release`);
    const command = `${prelude}while [ ! -f '${release}' ]; do sleep 0.05; done; exit $(cat '${release}')`;
    const projectId = await seedProject(taskId, repo, command);
    await seedTask(projectId, repo, taskId, `${name}.txt`);
    const sessionId = `${taskId}-session`;
    const at = new Date().toISOString();
    await db.insert(sessions).values({ id: sessionId, taskId, role: "single", agentType: "claude", executor: "claude",
      cwd: repo, startedAt: at, turnStartedAt: at, endedAt: at, activeMs: 0 });
    return { repo, taskId, release, command, before: main(repo), timeline: () => read(sessionTranscriptPath(taskId, sessionId)) };
  }

  /** 让另一个进程发起这次验收，命令放行后把它 SIGKILL 掉。返回它留下的那一行。 */
  async function crashMidRun(taskId: string) {
    const worker = spawn(process.execPath, ["--import", "tsx", crashWorker, taskId, "armed"],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let diagnostic = "";
    worker.stderr?.on("data", chunk => { diagnostic += String(chunk); });
    const signal = await new Promise<string | null>((resolve, reject) => {
      const timeout = setTimeout(() => { worker.kill("SIGKILL"); reject(new Error(diagnostic || "crash worker timed out")); }, 20_000);
      worker.once("error", reject);
      worker.once("exit", (_code, exitSignal) => { clearTimeout(timeout); resolve(exitSignal); });
    });
    assert.equal(signal, "SIGKILL", diagnostic);
    const row = await runOf(taskId);
    assert.equal(row.status, "running");
    assert.equal(readGateLaunch(row.logPath)?.phase, "armed", "旧实例死前命令已经放行");
    assert.equal(hasLiveAcceptGate(taskId), false, "本进程从没见过这条运行：跟一个新起来的 ash 一样");
    return row;
  }

  // (a) 命令还在跑：接管，看门的重挂，最后按真实 rc 结算并自动续验收。
  {
    const s = await stage("live");
    const row = await crashMidRun(s.taskId);
    assert.equal(alive(row.pid!), true);
    overrideGateWatchTimings({ progressMs: 40, sampleMs: 20, silenceMs: 80 });
    try {
      const recovered = await recoverAcceptGates();
      assert.equal(recovered.resumed, 1);
      assert.equal((await runOf(s.taskId)).status, "running", "接管不是结算");
      assert.equal(hasLiveAcceptGate(s.taskId), true);
      assert.equal((await acceptGateState(s.taskId)).running?.id, row.id, "验收台上看得见接管的那一次");
      assert.match(s.timeline(), /新实例已经接管/);
      // 看门的真的重挂了：进度和静默提醒在接管之后继续往 .notes 里写；接上之前的那段按「看不见」说。
      await until(() => /进度 · 开跑后/.test(read(gateNotesPath(row.logPath)))
        && /接上这份日志起，连续/.test(read(gateNotesPath(row.logPath))), "看门的重挂");
      assert.match(read(gateNotesPath(row.logPath)), /新实例接管了这条仍在跑的命令/);
      const blocked = await acceptTask(s.taskId);
      assert.equal(blocked.accepted, false);
      if (!blocked.accepted) assert.equal(blocked.reason, "accept_gate_running", "接管期间照常按「正在跑」拦住");
      writeFileSync(s.release, "0");
      await settled(s.taskId);
    } finally { overrideGateWatchTimings(null); }
    const done = await runOf(s.taskId);
    assert.equal(done.status, "passed");
    assert.equal(done.exitCode, 0);
    assert.equal(done.processPending, false);
    assert.equal((await taskRow(s.taskId)).stage, "accepted", "接管后转绿，照常自动把验收做完");
    assert.notEqual(main(s.repo), s.before);
    assert.equal(hasLiveAcceptGate(s.taskId), false);
  }

  // (a') 接管后的超时从**开跑那一刻**算：重启前已经跑掉的时间不清零。
  {
    const s = await stage("timeout");
    const row = await crashMidRun(s.taskId);
    const limit = 3_000;
    await until(() => Date.now() - Date.parse(row.startedAt) > limit + 200, "跑过时限", limit + 5_000);
    overrideGateWatchTimings({ timeoutMs: limit, sampleMs: 20 });
    const resumedAt = Date.now();
    try {
      assert.equal((await recoverAcceptGates()).resumed, 1);
      await settled(s.taskId);
    } finally { overrideGateWatchTimings(null); }
    assert.ok(Date.now() - resumedAt < limit - 1_000, "从接管那一刻重新计时的话，这里还得再等一整个时限");
    const done = await runOf(s.taskId);
    assert.equal(done.status, "failed");
    assert.equal(done.failure, "timeout");
    await until(() => !alive(row.pid!), "超时收掉命令");
    for (let i = 0; i < 200 && isTurnClaimed(s.taskId); i++) await sleep(25);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, s.taskId));
    releaseTurn(s.taskId);
  }

  // (b) 重启期间已经 rc=0 跑完：按退出档结算 passed，照常自动续验收。
  {
    const s = await stage("passed");
    const row = await crashMidRun(s.taskId);
    writeFileSync(s.release, "0");
    await until(() => existsSync(gateExitPath(row.logPath)) && !alive(row.pid!), "命令跑完");
    const recovered = await recoverAcceptGates();
    assert.equal(recovered.settled, 1);
    await settled(s.taskId);
    const done = await runOf(s.taskId);
    assert.equal(done.status, "passed");
    assert.equal(done.exitCode, 0);
    assert.equal((await taskRow(s.taskId)).stage, "accepted", "rc=0 就该跟没重启过一样自动合并");
    assert.notEqual(main(s.repo), s.before);
    assert.match(read(row.logPath), /读到命令自己留下的退出结果（rc=0）/);
    assert.match(s.timeline(), /已经跑完（rc=0）/);
  }

  // (c) 重启期间已经 rc≠0 跑完：结算 failed，照常交回任务去修，目标分支不动。
  {
    const s = await stage("failed");
    const row = await crashMidRun(s.taskId);
    writeFileSync(s.release, "3");
    await until(() => existsSync(gateExitPath(row.logPath)) && !alive(row.pid!), "命令跑完");
    assert.equal((await recoverAcceptGates()).settled, 1);
    await settled(s.taskId);
    const done = await runOf(s.taskId);
    assert.equal(done.status, "failed");
    assert.equal(done.failure, "exit_code");
    assert.equal(done.exitCode, 3);
    assert.equal(main(s.repo), s.before, "红了目标分支一个字节都不许动");
    assert.equal((await taskRow(s.taskId)).stage, "verified");
    const woke = async () => (await db.select().from(sessions).where(eq(sessions.taskId, s.taskId))).length > 1;
    await until(woke, "交回任务去修");
    assert.ok((await runOf(s.taskId)).handoffAt, "红了照常交接，并留下刷新后看得见的记录");
    for (let i = 0; i < 200 && (await taskRow(s.taskId)).status !== "running"; i++) await sleep(25);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, s.taskId));
    releaseTurn(s.taskId);
  }

  // (d) 启动器连同结果一起没了：维持老结局「被打断」，文案不变，残留进程照样收掉。
  {
    const childFile = join(root, "takeover-lost.pid");
    const s = await stage("lost", `echo $$ > '${childFile}'; `);
    const row = await crashMidRun(s.taskId);
    await until(() => existsSync(childFile) && read(childFile).trim().length > 0, "命令起来");
    const child = Number(read(childFile).trim());
    process.kill(row.pid!, "SIGKILL");
    await until(() => !alive(row.pid!), "启动器消失");
    assert.equal(existsSync(gateExitPath(row.logPath)), false, "启动器被杀不能留下退出档");
    assert.equal(alive(child), true);
    const recovered = await recoverAcceptGates();
    assert.equal(recovered.interrupted, 1);
    const done = await runOf(s.taskId);
    assert.equal(done.status, "interrupted");
    assert.equal(done.failure, "server_restarted");
    assert.ok(s.timeline().includes(`验收前置命令被打断：ash 重启时它还在跑（\`${s.command}\`），已按未完成收尾。`));
    assert.match(read(row.logPath), /ash 重启后核对进程，执行状态为 interrupted/);
    await until(() => !alive(child), "残留进程收掉");
    assert.equal(main(s.repo), s.before);
  }

  // 身份核验：pid 被复用、退出档对不上、ash 自己喊过停 —— 一律不接管、不结算。
  const stranger = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
  const strangerPid = stranger.pid!;
  try {
    const log = join(root, "reused.log");
    prepareGateLaunch(log);
    writeGateLaunch(log, { version: 1, phase: "armed", pid: strangerPid, startedAt: "earlier-generation",
      confinementId: "orchestration-fixture:0", confinementEnrolled: true });
    writeFileSync(gateGoPath(log), "go");
    const run = { pid: strangerPid, pidStartedAt: "earlier-generation", logPath: log };
    assert.equal(gateRecoveryFate(run).kind, "lost", "pid 还在但启动时间是别人的：不是我们那条命令");
    const record = (pid: number, code: number) => writeFileSync(gateExitPath(log),
      JSON.stringify({ version: 1, pid, code, childSignal: null, finishedAt: new Date().toISOString() }));
    record(strangerPid + 1, 0);
    assert.equal(gateRecoveryFate(run).kind, "lost", "别的启动器写的退出档不认");
    writeFileSync(gateExitPath(log), "{\"version\":1,\"pid\":");
    assert.equal(gateRecoveryFate(run).kind, "lost", "半截档不认");
    record(strangerPid, 0);
    assert.deepEqual(gateRecoveryFate(run), { kind: "exited", exit: { code: 0, signal: null } },
      "这一次的启动器留下的完整退出档，不受之后 pid 被谁复用影响");
    writeFileSync(gateAbortPath(log), "abort");
    assert.equal(gateRecoveryFate(run).kind, "lost", "ash 自己喊过停：退出档里的不是命令自己的结论");
    rmSync(gateAbortPath(log));
    writeGateLaunch(log, { ...readGateLaunch(log)!, phase: "stopped" });
    assert.equal(gateRecoveryFate(run).kind, "lost");

    const fresh = join(root, "fresh.log");
    writeFileSync(gateExitPath(fresh), JSON.stringify({ version: 1, pid: strangerPid, code: 0 }));
    prepareGateLaunch(fresh);
    assert.equal(existsSync(gateExitPath(fresh)), false, "起跑前清掉同路径的旧档，不认领上一次的残留");

    // 接管期间 pid 被复用：认定它已经没了（给 null = 拿不到结果），绝不朝复用者发信号、也不干等。
    rmSync(gateExitPath(log));
    const waited = (startedAt: string, within: number) => new Promise<GateExit | null | "pending">(resolve => {
      const watch = watchGateExit({ logPath: log, pid: strangerPid, startedAt, onExit: resolve });
      setTimeout(() => { watch.stop(); resolve("pending"); }, within);
    });
    assert.equal(await waited("earlier-generation", 3_000), null);
    assert.equal(alive(strangerPid), true, "等待者只看不动");
    const identity = inspectProcessSync(strangerPid)!.startedAt!;
    assert.equal(await waited(identity, 1_500), "pending", "身份核得上就继续等");
    record(strangerPid, 7);
    assert.deepEqual(await waited(identity, 3_000), { code: 7, signal: null });

    // 整条恢复路径上同样如此：库里一条 running 行指着被复用的 pid，还带着一份对不上的退出档。
    const repo = makeRepo("takeover-reused");
    const taskId = "gate-takeover-reused";
    const projectId = await seedProject(taskId, repo, null);
    await seedTask(projectId, repo, taskId, "reused.txt");
    record(strangerPid + 1, 0);
    await db.insert(acceptGateRuns).values({ id: "takeover-reused-run", taskId, projectId, command: "reused", cwd: repo,
      status: "running", pid: strangerPid, pidStartedAt: "earlier-generation", processPending: true,
      logPath: log, startedAt: new Date().toISOString() });
    writeGateLaunch(log, { ...readGateLaunch(log)!, phase: "armed" });
    await recoverAcceptGates();
    const reused = await runOf(taskId);
    assert.equal(reused.status, "interrupted", "身份对不上：不接管、不结算");
    assert.equal(alive(strangerPid), true, "也绝不误杀复用者");
    assert.equal((await forceReleaseAcceptGate(taskId, reused.id)).ok, true);
    await sleep(200); // 释放那一下的状态广播是异步发出的，别让它撞上测试末尾已关的库
  } finally {
    try { process.kill(strangerPid, "SIGKILL"); } catch {}
  }
  console.log("accept gate takeover: 接管并按真实 rc 结算 / 接管后超时从开跑算 / 退出档绿 / 退出档红 / 无档被打断 / pid 复用不接管不误杀 passed");
}
