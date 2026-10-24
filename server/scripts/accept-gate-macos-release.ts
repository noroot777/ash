import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { spawnAcceptGate, stopAcceptGate } from "../src/accept-gate-process.js";
import { readGateLaunch, abandonGateSupervision } from "../src/accept-gate-launch.js";
import { isPidAlive } from "../src/platform.js";
import { gateFailurePrompt, gateStoppedSummary } from "../src/accept-gate-messages.js";
import { MAC_GATE_NOTICE } from "../src/accept-gate-confinement-macos.js";
import { releaseTmpDb } from "./tmp-db.js";

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("macOS release condition timed out");
    await sleep(50);
  }
}

export async function testMacGateRelease(directory: string): Promise<object> {
  mkdirSync(directory, { recursive: true });
  const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks, acceptGateRuns } = await import("../src/db/schema.js");
  const { forceReleaseAcceptGate } = await import("../src/accept-gate.js");
  const { claimGateProcess, attachGateProcess, hasOwnedGateProcess } = await import("../src/accept-gate-ownership.js");
  const taskId = "macos-waiver-task";
  const runId = "macos-waiver-run";
  const logPath = join(directory, "release.log");
  const proofPath = `${logPath}.macos-processes.json`;
  let original: string | null = null;
  let started: Awaited<ReturnType<typeof spawnAcceptGate>> | null = null;
  try {
    await ensureSchema();
    const stamp = new Date().toISOString();
    await db.insert(projects).values({ id: "macos-waiver-project", name: "waiver", repoPath: directory, createdAt: stamp });
    await db.insert(tasks).values({ id: taskId, projectId: "macos-waiver-project", title: "waiver", status: "done", createdAt: stamp, updatedAt: stamp });
    started = await spawnAcceptGate({ command: "sleep 60", cwd: directory, logPath, onExit: () => undefined });
    original = readFileSync(proofPath, "utf8");
    const guardian = JSON.parse(original).guardian;
    await db.insert(acceptGateRuns).values({ id: runId, taskId, projectId: "macos-waiver-project", command: "sleep 60",
      cwd: directory, logPath, status: "failed", failure: "process_unconfirmed", processPending: true,
      pid: started.pid, pidStartedAt: started.startedAt, executionMode: "macos-observed", startedAt: stamp });
    claimGateProcess(runId, taskId, logPath);
    attachGateProcess(runId, started.pid, started.startedAt, true);
    await dbClient.execute("CREATE TRIGGER reject_waiver BEFORE UPDATE ON accept_gate_runs WHEN NEW.failure = 'ownership_waived' BEGIN SELECT RAISE(FAIL, 'waiver persistence failure'); END");
    await assert.rejects(forceReleaseAcceptGate(taskId, runId), /waiver persistence failure/);
    const before = statSync(proofPath).mtimeMs;
    await until(() => statSync(proofPath).mtimeMs > before);
    assert.equal(isPidAlive(guardian.pid), true, "failed persistence keeps supervision alive");
    await dbClient.execute("DROP TRIGGER reject_waiver");
    writeFileSync(proofPath, "missing identity evidence");
    assert.equal((await forceReleaseAcceptGate(taskId, runId)).ok, true);
    assert.equal(hasOwnedGateProcess(taskId), false);
    assert.equal((await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, runId)))[0]?.processPending, false);
    assert.equal(readGateLaunch(logPath)?.phase, "armed");
    assert.equal(readGateLaunch(logPath)?.stoppedEvidence, undefined, "waiving responsibility is not proof of exit");
    await until(() => !isPidAlive(guardian.pid));
    writeFileSync(proofPath, original);
    const after = statSync(proofPath).mtimeMs;
    await sleep(900);
    assert.equal(statSync(proofPath).mtimeMs, after, "released scanner must not keep rewriting evidence");
    assert.equal((await forceReleaseAcceptGate(taskId, runId)).ok, true);
    const details = { command: "test", summary: "failed", logPath, tail: "error", cwd: directory, sourceCwd: directory };
    assert.match(gateFailurePrompt({ ...details, executionNotice: MAC_GATE_NOTICE }), /停止后快照保留，不自动删除/);
    assert.doesNotMatch(gateFailurePrompt({ ...details, executionNotice: MAC_GATE_NOTICE }), /停止后快照会删除/);
    assert.match(gateFailurePrompt(details), /停止后快照会删除/);
    assert.match(gateStoppedSummary("macos-observed"), /已识别进程.*快照保留.*不代表未观察后代全部退出/);
    assert.equal(gateStoppedSummary(null), "残留进程已收掉");
    return { mode: "macos-released-supervision", persistedBeforeDispose: true, scannerStopped: true, noFalseExitProof: true, scopedMessages: true };
  } finally {
    try {
      if (original) writeFileSync(proofPath, original);
      if (started) assert.equal(await stopAcceptGate(taskId, started.pid, started.startedAt, logPath), true);
    } finally {
      abandonGateSupervision(logPath);
      await releaseTmpDb();
    }
  }
}
