import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, dbClient } from "../src/db/index.js";
import { acceptGateRuns, projects, tasks } from "../src/db/schema.js";
import { acceptTask } from "../src/task-accept.js";
import { acceptGateState, cancelAcceptGate, hasLiveAcceptGate, recoverAcceptGates } from "../src/accept-gate.js";
import { hasStoppingGateProcess } from "../src/accept-gate-ownership.js";
import { acceptGateLogTail, acceptGateLogText, spawnAcceptGate } from "../src/accept-gate-process.js";
import { taskBusyRejection } from "../src/task-busy.js";
import { bus } from "../src/bus.js";
import { reopenAcceptedStage, restoreTaskStage } from "../src/task-stage.js";
import { killTree } from "../src/platform.js";

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error("lifecycle condition timed out");
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export type GateFixture = {
  root: string;
  makeRepo: (name: string) => string;
  seedProject: (name: string, repo: string, command: string | null) => Promise<string>;
  seedTask: (projectId: string, repo: string, taskId: string, file: string) => Promise<string>;
  taskRow: (taskId: string) => Promise<typeof tasks.$inferSelect>;
  settled: (taskId: string) => Promise<void>;
};

export async function testGateLifecycle(fixture: GateFixture): Promise<void> {
  const { root, makeRepo, seedProject, seedTask, taskRow, settled } = fixture;
  {
    const repo = makeRepo("stop-race");
    const childFile = join(root, "stop-race.pid");
    const projectId = await seedProject("stop-race", repo,
      `sh -c 'trap "" TERM; echo $$ > ${childFile}; sleep 120' & sleep 120`);
    const taskId = "gate-stop-race";
    const workspace = await seedTask(projectId, repo, taskId, "stop-race.txt");
    await acceptTask(taskId);
    await until(() => existsSync(childFile));
    const child = Number(readFileSync(childFile, "utf8").trim());
    const canceled = cancelAcceptGate(taskId);
    await until(() => hasStoppingGateProcess(taskId));
    try {
      for (const intent of ["skip", "rerun"] as const) {
        const result = await acceptTask(taskId, "human", { acceptGate: intent });
        assert.equal(result.accepted, false);
        if (!result.accepted) assert.equal(result.reason, "accept_gate_running");
      }
      await db.update(projects).set({ acceptGateCommand: null }).where(eq(projects.id, projectId));
      assert.equal((await acceptTask(taskId)).accepted, false, "撤掉命令不能绕过停止占用");
      assert.ok(await taskBusyRejection(taskId, "删除"));
      assert.equal(existsSync(workspace), true);
      assert.equal(alive(child), true);
      assert.notEqual((await taskRow(taskId)).stage, "accepted");
    } finally { await canceled; }
    assert.equal(alive(child), false);
    assert.equal(hasLiveAcceptGate(taskId), false);
    assert.equal((await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId)))[0].processPending, false);
    assert.equal((await acceptTask(taskId)).accepted, true);
  }

  for (const initialCommand of [null, "true"]) {
    const name = initialCommand ? "receipt-keep-passed" : "receipt-keep-unset";
    const repo = makeRepo(name);
    const projectId = await seedProject(name, repo, initialCommand);
    const taskId = `gate-${name}`;
    const workspace = await seedTask(projectId, repo, taskId, `${name}.txt`);
    const hook = join(repo, ".git/hooks/post-merge");
    writeFileSync(hook, `#!/bin/sh\nprintf hold > '${workspace}/cleanup-blocker'\n`);
    chmodSync(hook, 0o755);
    const readings: Promise<Awaited<ReturnType<typeof acceptGateState>>>[] = [];
    const unsubscribe = bus.subscribe(event => {
      if (event.type === "task.acceptGate" && event.taskId === taskId) readings.push(acceptGateState(taskId));
    });
    try {
      await acceptTask(taskId);
      if (initialCommand) await settled(taskId);
      const merged = await taskRow(taskId);
      assert.equal(merged.stage, "merged");
      assert.equal(merged.acceptedGateMode, initialCommand ? "passed" : "unset");
      const gateCount = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId))).length;
      rmSync(join(workspace, "cleanup-blocker"));
      rmSync(hook);
      await db.update(projects).set({ acceptGateCommand: initialCommand ? null : "false" }).where(eq(projects.id, projectId));
      assert.equal((await acceptTask(taskId, "human", { acceptGate: "rerun" })).accepted, true,
        "已合并后补清理不应重新触发门禁");
      const accepted = await taskRow(taskId);
      assert.equal(accepted.acceptedGateMode, merged.acceptedGateMode);
      assert.equal(accepted.acceptedGateRunId, merged.acceptedGateRunId);
      assert.equal(accepted.acceptedMergeCommit, merged.acceptedMergeCommit);
      assert.equal((await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId))).length, gateCount);
      assert.ok((await Promise.all(readings)).some(state => state.basis?.mode === merged.acceptedGateMode),
        "凭据持久化之后必须广播可读的新凭据");
      const reopened = await reopenAcceptedStage(taskId);
      assert.equal((await taskRow(taskId)).acceptedGateMode, null);
      assert.ok(reopened);
      await restoreTaskStage(taskId, reopened.stage, "test restore", reopened.snapshot);
      assert.equal((await taskRow(taskId)).acceptedGateMode, merged.acceptedGateMode);
      assert.equal((await taskRow(taskId)).acceptedGateRunId, merged.acceptedGateRunId);
    } finally { unsubscribe(); }
  }

  {
    const repo = makeRepo("recover-terminal");
    const projectId = await seedProject("recover-terminal", repo, null);
    const taskId = "gate-recover-terminal";
    const workspace = await seedTask(projectId, repo, taskId, "terminal.txt");
    const childFile = join(root, "recover-terminal.pid");
    const started = spawnAcceptGate({
      command: `sh -c 'trap "" TERM; echo $$ > ${childFile}; sleep 120' & sleep 120`,
      cwd: workspace, logPath: join(root, "recover-terminal.log"), onExit: () => {},
    });
    await until(() => existsSync(childFile));
    const child = Number(readFileSync(childFile, "utf8").trim());
    const runId = "recover-terminal-run";
    await db.insert(acceptGateRuns).values({
      id: runId, taskId, projectId, command: "recovery fixture", cwd: workspace,
      status: "canceled", pid: started.pid, pidStartedAt: started.startedAt,
      processPending: true, startedAt: new Date().toISOString(), logPath: join(root, "recover-terminal.log"),
    });
    assert.equal((await acceptTask(taskId, "human", { acceptGate: "skip" })).accepted, false,
      "共同守卫直接读取持久占用，不依赖本轮进程表或启动恢复是否成功");
    process.kill(started.pid, "SIGTERM");
    await until(() => !alive(started.pid));
    assert.equal(alive(child), true, "领头进程退出时同组后代仍在");
    await recoverAcceptGates();
    assert.equal(alive(child), false, "重启必须收回终态行里尚未释放的进程组");
    assert.equal((await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, runId)))[0].status, "canceled");
    assert.equal(hasLiveAcceptGate(taskId), false);
  }

  {
    const repo = makeRepo("stop-unconfirmed");
    const projectId = await seedProject("stop-unconfirmed", repo, null);
    const taskId = "gate-stop-unconfirmed";
    const workspace = await seedTask(projectId, repo, taskId, "unconfirmed.txt");
    const started = spawnAcceptGate({ command: "sleep 120", cwd: workspace,
      logPath: join(root, "unconfirmed.log"), onExit: () => {} });
    const runId = "stop-unconfirmed-run";
    await db.insert(acceptGateRuns).values({
      id: runId, taskId, projectId, command: "identity mismatch", cwd: workspace, status: "running",
      pid: started.pid, pidStartedAt: "not-this-generation", processPending: false,
      startedAt: new Date().toISOString(), logPath: join(root, "unconfirmed.log"),
    });
    try {
      await recoverAcceptGates();
      await recoverAcceptGates();
      assert.equal(alive(started.pid), true, "身份不符时不能误杀无关进程");
      assert.equal(hasLiveAcceptGate(taskId), true);
      assert.equal((await acceptTask(taskId, "human", { acceptGate: "skip" })).accepted, false);
      assert.ok(await taskBusyRejection(taskId, "删除"));
      assert.equal((await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, runId)))[0].processPending, true);
    } finally {
      killTree(started.pid, "SIGKILL");
      await until(() => !alive(started.pid));
    }
    assert.equal((await acceptTask(taskId)).accepted, true, "进程真正退出后共同守卫会自动释放占用");
    assert.equal((await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, runId)))[0].processPending, false);
  }

  {
    const repo = makeRepo("settle-retry");
    const projectId = await seedProject("settle-retry", repo, "sleep 120");
    const taskId = "gate-settle-retry";
    await seedTask(projectId, repo, taskId, "settle.txt");
    await acceptTask(taskId);
    await dbClient.execute(`CREATE TRIGGER reject_gate_settle BEFORE UPDATE OF status ON accept_gate_runs
      WHEN OLD.task_id = '${taskId}' BEGIN SELECT RAISE(FAIL, 'temporary gate failure'); END`);
    try {
      await cancelAcceptGate(taskId);
      assert.equal((await acceptGateState(taskId)).running?.status, "running");
      assert.equal(hasLiveAcceptGate(taskId), true);
    } finally { await dbClient.execute("DROP TRIGGER reject_gate_settle"); }
    await cancelAcceptGate(taskId);
    assert.equal((await acceptGateState(taskId)).latest?.status, "canceled");
    assert.equal(hasLiveAcceptGate(taskId), false, "持久化失败后能重试结算");
  }
  {
    const log = join(root, "utf8.log");
    writeFileSync(log, "测".repeat(400_000));
    assert.match(acceptGateLogText(log), /1\.2 MB/);
    assert.doesNotMatch(acceptGateLogTail(log), /\ufffd/);
    assert.doesNotMatch(acceptGateLogText(log), /\ufffd/);
  }
  console.log("accept gate lifecycle: 并发停止闸 / 合并凭据冻结 / 凭据广播 / 终态进程恢复 / 结算失败重试 passed");
}
