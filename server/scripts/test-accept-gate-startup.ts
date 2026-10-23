import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, dbClient } from "../src/db/index.js";
import { acceptGateRuns, projects } from "../src/db/schema.js";
import { acceptTask } from "../src/task-accept.js";
import { acceptGateCheck, acceptGateState, cancelAcceptGate, hasLiveAcceptGate,
  recoverAcceptGates, startPendingAcceptGate } from "../src/accept-gate.js";
import { acceptGateLogPath } from "../src/accept-gate-process.js";
import { readGateLaunch } from "../src/accept-gate-launch.js";
import { taskBusyRejection } from "../src/task-busy.js";
import { mountAcceptGateRoutes } from "../src/accept-gate-routes.js";
import { enrichTasks } from "../src/task-store.js";
import type { GateFixture } from "./test-accept-gate-lifecycle.js";

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function testGateStartup(fixture: GateFixture): Promise<void> {
  const { root, makeRepo, seedProject, seedTask, taskRow, settled } = fixture;
  const runsOf = (taskId: string) => db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId));
  for (const fault of ["select", "insert"]) {
    const repo = makeRepo(`startup-${fault}`);
    const taskId = `gate-startup-${fault}`;
    const projectId = await seedProject(taskId, repo, "true");
    await seedTask(projectId, repo, taskId, `${fault}.txt`);
    const project = (await db.select().from(projects).where(eq(projects.id, projectId)))[0];
    await acceptGateCheck(await taskRow(taskId), project, { choices: { by: "human" }, onBasis: () => {} });
    const select = db.select;
    if (fault === "select") db.select = (() => { throw new Error("temporary select failure"); }) as typeof select;
    else await dbClient.execute(`CREATE TRIGGER fail_gate_start BEFORE INSERT ON accept_gate_runs
      WHEN NEW.task_id = '${taskId}' BEGIN SELECT RAISE(FAIL, 'temporary insert failure'); END`);
    try { await assert.rejects(startPendingAcceptGate(taskId), /temporary/); }
    finally {
      db.select = select;
      if (fault === "insert") await dbClient.execute("DROP TRIGGER fail_gate_start");
    }
    assert.equal(hasLiveAcceptGate(taskId), false);
    assert.equal((await runsOf(taskId)).length, 0);
    assert.equal((await cancelAcceptGate(taskId)).outcome, "not_running");
    assert.equal(await taskBusyRejection(taskId, "删除"), null);
    await acceptTask(taskId);
    await settled(taskId);
    assert.equal((await taskRow(taskId)).stage, "accepted");
  }

  {
    const repo = makeRepo("startup-pid-error");
    const taskId = "gate-startup-pid-error";
    const marker = join(root, "must-not-start");
    const projectId = await seedProject(taskId, repo, `echo started > '${marker}'`);
    await seedTask(projectId, repo, taskId, "pid-error.txt");
    await dbClient.execute(`CREATE TRIGGER fail_gate_pid BEFORE UPDATE OF pid ON accept_gate_runs
      WHEN OLD.task_id = '${taskId}' BEGIN SELECT RAISE(FAIL, 'temporary pid failure'); END`);
    try { await acceptTask(taskId); await settled(taskId); }
    finally { await dbClient.execute("DROP TRIGGER fail_gate_pid"); }
    const row = (await runsOf(taskId))[0];
    assert.equal(row.failure, "spawn_failed");
    assert.equal(row.processPending, false);
    assert.equal(hasLiveAcceptGate(taskId), false);
    assert.equal(existsSync(marker), false);
  }

  if (process.platform !== "win32") for (const phase of ["before-pid", "after-pid"]) {
    const repo = makeRepo(`crash-${phase}`);
    const taskId = `gate-crash-${phase}`;
    const marker = join(root, `${phase}-must-not-start`);
    const projectId = await seedProject(taskId, repo, `echo started > '${marker}'; sleep 120`);
    const workspace = await seedTask(projectId, repo, taskId, `${phase}.txt`);
    const worker = spawn(process.execPath, ["--import", "tsx",
      fileURLToPath(new URL("./accept-gate-crash-worker.ts", import.meta.url)), taskId, phase],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let diagnostic = "";
    worker.stderr?.on("data", chunk => { diagnostic += String(chunk); });
    const signal = await new Promise<string | null>((resolve, reject) => {
      const timeout = setTimeout(() => { worker.kill("SIGKILL"); reject(new Error(diagnostic || "crash worker timed out")); }, 15_000);
      worker.once("error", reject);
      worker.once("exit", (_code, exitSignal) => { clearTimeout(timeout); resolve(exitSignal); });
    });
    assert.equal(signal, "SIGKILL", diagnostic);
    const row = (await runsOf(taskId))[0];
    assert.equal(row.processPending, true);
    assert.equal(row.pid === null, phase === "before-pid");
    assert.equal(readGateLaunch(acceptGateLogPath(taskId, row.id))?.phase, "prepared");
    await recoverAcceptGates();
    assert.equal((await runsOf(taskId))[0].status, "interrupted");
    assert.equal(hasLiveAcceptGate(taskId), false);
    await db.update(projects).set({ acceptGateCommand: null }).where(eq(projects.id, projectId));
    assert.equal((await acceptTask(taskId)).accepted, true);
    assert.equal(existsSync(workspace), false);
    await sleep(100);
    assert.equal(existsSync(marker), false, "崩溃后迟到的启动器不能再执行命令");
  }

  {
    const repo = makeRepo("unknown-launch");
    const taskId = "gate-unknown-launch";
    const projectId = await seedProject(taskId, repo, null);
    await seedTask(projectId, repo, taskId, "unknown.txt");
    await db.insert(acceptGateRuns).values({ id: "unknown-launch-run", taskId, projectId, command: "legacy",
      cwd: repo, status: "running", pid: null, processPending: false,
      logPath: join(root, "missing-identity.log"), startedAt: new Date().toISOString() });
    assert.ok(await taskBusyRejection(taskId, "删除"), "冷启动也重新读取旧的running行，不能只信内存或新增列的默认值");
    await recoverAcceptGates();
    assert.equal(hasLiveAcceptGate(taskId), true, "缺失身份不是退出证明");
    assert.equal((await acceptGateState(taskId)).running?.status, "interrupted");
    assert.equal((await enrichTasks([await taskRow(taskId)]))[0].acceptGateRunning, true);
    assert.equal((await cancelAcceptGate(taskId)).outcome, "stopping");
    assert.ok(await taskBusyRejection(taskId, "删除"));
    assert.equal((await acceptTask(taskId, "human", { acceptGate: "skip" })).accepted, false);
  }

  const api = new Hono();
  mountAcceptGateRoutes(api);
  {
    const repo = makeRepo("automatic-target-drift");
    const taskId = "gate-automatic-target-drift";
    const release = join(root, "release-drift");
    const projectId = await seedProject(taskId, repo, `while [ ! -f '${release}' ]; do sleep 0.05; done`);
    await seedTask(projectId, repo, taskId, "source-drift.txt");
    await acceptTask(taskId);
    writeFileSync(join(repo, "target-drift.txt"), "target advanced\n");
    execFileSync("git", ["-C", repo, "add", "target-drift.txt"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "target advanced"]);
    writeFileSync(release, "release");
    await settled(taskId);
    assert.equal((await taskRow(taskId)).stage, "accepted");
    assert.equal((await acceptGateState(taskId)).basis?.run?.fastForward, false,
      "自动续验收也必须持久化目标变化，回执才会说明没有测最终合并树");
  }
  {
    const repo = makeRepo("cancel-run-identity");
    const taskId = "gate-cancel-run-identity";
    const projectId = await seedProject(taskId, repo, "sleep 120");
    await seedTask(projectId, repo, taskId, "cancel.txt");
    await acceptTask(taskId);
    const row = (await runsOf(taskId))[0];
    assert.equal((await cancelAcceptGate(taskId, undefined, "not-this-run")).outcome, "not_running");
    assert.equal((await acceptGateState(taskId)).running?.id, row.id);
    assert.equal((await cancelAcceptGate(taskId, undefined, row.id)).outcome, "canceled");
    assert.equal((await cancelAcceptGate(taskId, undefined, row.id)).outcome, "already_finished");
  }
  for (const status of ["passed", "failed", "interrupted", "canceled"] as const) {
    const repo = makeRepo(`late-${status}`);
    const taskId = `gate-late-${status}`;
    const projectId = await seedProject(taskId, repo, "true");
    await seedTask(projectId, repo, taskId, `${status}.txt`);
    await acceptTask(taskId);
    await settled(taskId);
    const row = (await runsOf(taskId))[0];
    await db.update(acceptGateRuns).set({ status }).where(eq(acceptGateRuns.id, row.id));
    const response = await api.request(`/tasks/${taskId}/accept-gate/cancel`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: row.id }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.outcome, "already_finished");
    assert.equal(result.runId, row.id);
    assert.equal(result.gate.status, status);
    assert.equal((await taskRow(taskId)).stage, "accepted");
    assert.equal(readFileSync(row.logPath, "utf8").includes("取消了"), false);
  }
  await sleep(100);
  console.log("accept gate startup: 起跑前查询/插入失败补偿 / pid写入失败 / 两处崩溃恢复 / 缺失身份保守占用 / 迟到取消契约 passed");
}
