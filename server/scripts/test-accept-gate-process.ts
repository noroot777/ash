import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gateTreeAlive, spawnAcceptGate, stopAcceptGate } from "../src/accept-gate-process.js";
import { gateGoPath, prepareGateLaunch, readGateLaunch, writeGateLaunch } from "../src/accept-gate-launch.js";
import { gateJobEvidencePath, readGateJobEvidence } from "../src/accept-gate-confinement-job.js";
import { gateJobSupervisorExecutable } from "../src/accept-gate-confinement-supervisor.js";
import { reopenConfinement } from "../src/executors/kernel-confine.js";
import { gateBootstrapEnvironment } from "../src/accept-gate-process-env.js";
import { isPidAlive, killTree } from "../src/platform.js";

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate: () => boolean, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(40);
  }
  throw new Error("gate process condition timed out");
}

const worker = fileURLToPath(new URL("./accept-gate-process-worker.ts", import.meta.url));
const runWorker = (mode: string, directory: string, allowFailure = false) => new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", worker, mode, directory], {
    stdio: ["ignore", "pipe", "pipe"], env: mode === "refusal-flow"
      ? { ...process.env, ASH_DB: join(directory, "ash.db"), ASH_RUNS_DIR: join(directory, "runs") } : process.env,
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  child.once("error", reject);
  child.once("exit", code => code === 0 || allowFailure ? resolve({ code, stdout }) : reject(new Error(stderr || stdout || `worker exit ${code}`)));
});

const root = mkdtempSync(join(tmpdir(), "ash-gate-process-"));
const results: object[] = [];
try {
  const isolated = gateBootstrapEnvironment({ PATH: "preserved", NODE_OPTIONS: "--require=preload.cjs",
    LD_PRELOAD: "preload.so", DYLD_INSERT_LIBRARIES: "preload.dylib" });
  assert.deepEqual(isolated.bootstrap, { PATH: "preserved" });
  assert.equal(isolated.restore.NODE_OPTIONS, "--require=preload.cjs");
  assert.equal(isolated.restore.LD_PRELOAD, "preload.so");
  assert.equal(isolated.restore.DYLD_INSERT_LIBRARIES, "preload.dylib");
  results.push({ mode: "bootstrap-environment", preloadsDeferredUntilConfinement: true });
  const absentLog = join(root, "missing-proof.log");
  prepareGateLaunch(absentLog);
  writeGateLaunch(absentLog, { version: 1, phase: "armed", pid: 2147483647, startedAt: "not-an-identity",
    confinementId: "Local\\ash-accept-gate-missing", confinementEnrolled: true });
  assert.equal(gateTreeAlive(2147483647, "not-an-identity", absentLog), true);
  writeGateLaunch(absentLog, { version: 1, phase: "stopped", pid: 2147483647 });
  assert.equal(gateTreeAlive(2147483647, null, absentLog), true, "旧 stopped/PID 消失不是整次退出证据");
  assert.equal(await stopAcceptGate("process-test", null, null, absentLog), false);
  results.push({ mode: "missing-evidence", legacyStoppedDoesNotRelease: true });
  const reusedLog = join(root, "unstarted-reused.log");
  prepareGateLaunch(reusedLog);
  writeGateLaunch(reusedLog, { version: 1, phase: "prepared", pid: process.pid, startedAt: "different-generation" });
  assert.equal(await stopAcceptGate("process-test", process.pid, "different-generation", reusedLog), true);
  assert.equal(isPidAlive(process.pid), true);
  results.push({ mode: "unstarted-reused-pid", unrelatedProcessNotSignaled: true, unstartedReleased: true });

  if (process.platform === "darwin") {
    const refusal = await runWorker("refusal-flow", join(root, "production-refusal"));
    results.push(JSON.parse(refusal.stdout.trim().split("\n").at(-1)!));
    const logPath = join(root, "refused.log");
    const marker = join(root, "must-not-execute");
    assert.throws(() => spawnAcceptGate({ command: `touch "${marker}"`, cwd: root, logPath,
      onExit: () => assert.fail("没有启动任何进程，不能伪造退出事件") }), /macOS.*内核围栏/);
    assert.equal(existsSync(marker), false);
    assert.equal(readGateLaunch(logPath)?.pid, undefined);
    assert.equal(await stopAcceptGate("process-test", null, null, logPath), true);
    assert.equal(gateTreeAlive(0, null, logPath), false);
    results.push({ mode: "macos-refusal", executedUserCode: false, unstartedReleased: true });

    const legacy = join(root, "legacy.log");
    const original = spawn(process.execPath, ["-e", `const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(join(root, "escaped.pid"))},String(process.pid));
        setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(join(root, "escaped.pulse"))},'.'),25)`)}],
      {detached:true,stdio:'ignore'});child.unref();`], { detached: true, stdio: "ignore" });
    original.unref();
    await until(() => existsSync(join(root, "escaped.pulse")));
    const escaped = Number(readFileSync(join(root, "escaped.pid"), "utf8"));
    try {
      await until(() => !isPidAlive(original.pid!));
      prepareGateLaunch(legacy);
      writeGateLaunch(legacy, { version: 1, phase: "armed", pid: original.pid, startedAt: "legacy" });
      writeFileSync(gateGoPath(legacy), "go");
      assert.equal(gateTreeAlive(original.pid!, "legacy", legacy), true);
      assert.equal(await stopAcceptGate("process-test", original.pid, "legacy", legacy), false);
      const recovery = await runWorker("recover-legacy", legacy);
      assert.equal(JSON.parse(recovery.stdout).stopped, false);
      const pulse = readFileSync(join(root, "escaped.pulse"), "utf8");
      await sleep(100);
      assert.notEqual(readFileSync(join(root, "escaped.pulse"), "utf8"), pulse);
      results.push({ mode: "legacy-detached", groupLeaderGone: true, escapedAlive: isPidAlive(escaped),
        normalExitCannotRelease: true, cancellationCannotRelease: true, recoveryCannotRelease: true });
    } finally { process.kill(escaped, "SIGKILL"); }
  } else {
    if (process.platform === "win32") {
      const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore", windowsHide: true,
      });
      const unrelatedPid = unrelated.pid!;
      try {
        for (const generation of ["", "2000-01-01T00:00:00.0000000Z"]) {
          const jobId = `Local\\ash-accept-gate-${randomUUID()}`;
          const evidence = join(root, `wrong-generation-${randomUUID()}.json`);
          const native = spawnSync(gateJobSupervisorExecutable(), [jobId, String(unrelatedPid), evidence,
            `${evidence}.abort`, generation], { timeout: 5000, windowsHide: true });
          assert.equal(native.status, 0, String(native.error ?? native.stderr));
          assert.equal(existsSync(evidence), false, "原生句柄代际缺失或不匹配时不能登记归属");
          assert.equal(reopenConfinement(jobId)?.read().kind, "absent");
          assert.equal(isPidAlive(unrelatedPid), true, "原生 supervisor 不能把复用的 PID 纳入会被停止的 Job");
        }
        results.push({ mode: "native-enroll-generation", missingGenerationRejected: true,
          reusedGenerationRejected: true, unrelatedProcessNotEnrolledOrSignaled: true });
      } finally {
        unrelated.kill("SIGKILL");
        await until(() => !isPidAlive(unrelatedPid));
      }
    }
    const normalExit = join(root, "normal-exit");
    const settlement = JSON.parse((await runWorker("settle", normalExit)).stdout.trim().split("\n").at(-1)!);
    assert.deepEqual(settlement, { code: 0, stopped: true });
    const normalPulse = readFileSync(`${normalExit}.pulse`, "utf8");
    await sleep(160);
    assert.equal(readFileSync(`${normalExit}.pulse`, "utf8"), normalPulse);
    assert.equal(readGateLaunch(`${normalExit}.log`)?.stoppedEvidence, "kernel-empty");
    results.push({ mode: "normal-exit-settlement", detachedCannotOutliveRelease: true, ...settlement });
    for (const mode of ["normal", "orphan", "reopen", "preload"]) {
      const directory = join(root, mode);
      let started: { controllerPid: number; pid: number; startedAt: string | null } | undefined;
      try {
        const control = await runWorker(mode === "normal" ? "controller-normal"
          : mode === "reopen" ? "controller-crash" : mode === "preload" ? "controller-preload" : "controller", directory, mode === "reopen");
        if (mode === "reopen") assert.notEqual(control.code, 0, "恢复用例必须真的终止原 controller");
        started = JSON.parse(readFileSync(`${directory}.controller.json`, "utf8"));
        const childPid = Number(readFileSync(`${directory}.pid`, "utf8"));
        const logPath = `${directory}.log`;
        const launchBefore = readGateLaunch(logPath)!;
        const jobEvidenceBefore = launchBefore.confinementId ? readGateJobEvidence(logPath, launchBefore.confinementId) : null;
        const preloadPids = mode === "preload"
          ? readFileSync(`${directory}.preload`, "utf8").trim().split("\n").map(Number) : undefined;
        if (preloadPids) assert.equal(preloadPids.includes(started!.pid), false);
        assert.equal(isPidAlive(started!.controllerPid), false);
        if (mode !== "normal") await until(() => !isPidAlive(started!.pid));
        assert.equal(isPidAlive(childPid), true);
        assert.equal(gateTreeAlive(started!.pid, started!.startedAt, logPath), true);
        const pulse = readFileSync(`${directory}.pulse`, "utf8");
        await sleep(200);
        assert.notEqual(readFileSync(`${directory}.pulse`, "utf8"), pulse, "controller 退出后 detached 后代仍在运行");
        const recovered = await runWorker("recover", directory);
        const state = JSON.parse(recovered.stdout.trim().split("\n").at(-1)!);
        assert.equal(state.aliveBefore, true);
        assert.equal(state.stopped, true);
        assert.equal(state.aliveAfter, false);
        const finalPulse = readFileSync(`${directory}.pulse`, "utf8");
        await sleep(160);
        assert.equal(readFileSync(`${directory}.pulse`, "utf8"), finalPulse);
        assert.equal(readGateLaunch(logPath)?.stoppedEvidence, "kernel-empty");
        results.push({ mode, controllerPid: started!.controllerPid, controllerExitCode: control.code,
          gatePid: started!.pid, gateStartedAt: started!.startedAt, childPid, preloadPids,
          originalControllerExited: true, liveDetachedObserved: true, pulseBytesBefore: pulse.length,
          pulseBytesAfterStop: finalPulse.length, launchBefore, jobEvidenceBefore,
          jobEvidenceAfter: launchBefore.confinementId ? readGateJobEvidence(logPath, launchBefore.confinementId) : null, ...state });
      } finally {
        if (started) assert.equal(await stopAcceptGate("process-test", started.pid, started.startedAt, `${directory}.log`), true);
      }
    }
    const directory = join(root, "all-exited");
    await runWorker("controller", directory);
    const started = JSON.parse(readFileSync(`${directory}.controller.json`, "utf8"));
    writeFileSync(`${directory}.finish`, "finish");
    await until(() => !gateTreeAlive(started.pid, started.startedAt, `${directory}.log`));
    const recovered = JSON.parse((await runWorker("recover", directory)).stdout.trim().split("\n").at(-1)!);
    assert.equal(recovered.aliveBefore, false);
    assert.equal(recovered.stopped, true);
    if (process.platform === "win32") {
      const launch = readGateLaunch(`${directory}.log`)!;
      assert.equal(readGateJobEvidence(`${directory}.log`, launch.confinementId!)?.state, "empty");
      assert.equal(reopenConfinement(launch.confinementId!)?.read().kind, "absent");
    }
    results.push({ mode: "all-exited-recovery", originalControllerExited: true, ...started,
      jobEvidenceAfter: readGateLaunch(`${directory}.log`)?.confinementId
        ? readGateJobEvidence(`${directory}.log`, readGateLaunch(`${directory}.log`)!.confinementId!) : null,
      jobAbsentAfterCompletion: process.platform === "win32", ...recovered });

    if (process.platform === "win32") {
      const lost = join(root, "supervisor-lost");
      await runWorker("controller", lost);
      const launch = readGateLaunch(`${lost}.log`)!;
      const evidence = readGateJobEvidence(`${lost}.log`, launch.confinementId!)!;
      process.kill(evidence.supervisorPid, "SIGKILL");
      await until(() => !isPidAlive(launch.pid!));
      assert.equal(reopenConfinement(launch.confinementId!)?.read().kind, "absent");
      assert.equal(readGateJobEvidence(`${lost}.log`, launch.confinementId!)?.state, "held");
      assert.equal(gateTreeAlive(launch.pid!, launch.startedAt, `${lost}.log`), true);
      assert.equal(await stopAcceptGate("process-test", launch.pid, launch.startedAt, `${lost}.log`), false);
      rmSync(gateJobEvidencePath(`${lost}.log`));
      assert.equal(gateTreeAlive(launch.pid!, launch.startedAt, `${lost}.log`), true);
      results.push({ mode: "supervisor-lost", launch, evidence,
        jobAbsentWithoutEmptyReceiptDoesNotRelease: true });
    }
  }
  console.log(JSON.stringify({ platform: process.platform, results }, null, 2));
} catch (error) {
  const diagnostics = readdirSync(root).filter(name => /\.(?:log|json)$/.test(name)).map(name => ({ name,
    content: readFileSync(join(root, name), "utf8").slice(-8000) }));
  console.error(JSON.stringify({ platform: process.platform, root, results, diagnostics }, null, 2));
  throw error;
} finally {
  for (const name of ["normal-exit", "normal", "orphan", "reopen", "preload", "all-exited", "supervisor-lost"]) {
    const logPath = join(root, `${name}.log`);
    const launch = readGateLaunch(logPath);
    if (launch && name !== "supervisor-lost") await stopAcceptGate("process-test", launch.pid, launch.startedAt, logPath);
    const pidPath = join(root, `${name}.pid`);
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, "utf8"));
      if (isPidAlive(pid)) killTree(pid, "SIGKILL");
    }
  }
  rmSync(root, { recursive: true, force: true });
}
