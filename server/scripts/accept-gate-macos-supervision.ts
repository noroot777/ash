import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { gateMacScannerExecutable } from "../src/accept-gate-macos-native.js";
import { macGateConfinement, MAC_GATE_ENV } from "../src/accept-gate-confinement-macos.js";
import { gateTreeAlive, spawnAcceptGate, stopAcceptGate } from "../src/accept-gate-process.js";
import { readGateLaunch } from "../src/accept-gate-launch.js";
import { isPidAlive } from "../src/platform.js";

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("macOS supervision condition timed out");
    await sleep(25);
  }
}

export async function testMacGateSupervision(root: string): Promise<object[]> {
  const results: object[] = [];
  const executable = await gateMacScannerExecutable();
  const token = randomUUID();
  const plain = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", `${MAC_GATE_ENV}=${token}`], {
    detached: true, stdio: "ignore", env: { ...process.env, [MAC_GATE_ENV]: "different", OTHER: `${MAC_GATE_ENV}=${token}` },
  });
  const marked = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, stdio: "ignore", env: { ...process.env, [MAC_GATE_ENV]: token },
  });
  const logs: string[] = [];
  const backups = new Map<string, string>();
  try {
    const rows = (JSON.parse(execFileSync(executable, ["scan", `${MAC_GATE_ENV}=${token}`], { encoding: "utf8" })) as {
      rows: { pid: number; born: number; marked: number }[];
    }).rows;
    assert.equal(rows.find(row => row.pid === marked.pid)?.marked, 1);
    assert.equal(rows.find(row => row.pid === plain.pid)?.marked, 0, "argv 和其它变量值中的文字不是环境项归属");
    const identity = rows.find(row => row.pid === plain.pid)!;
    assert.equal(spawnSync(executable, ["signal", String(plain.pid), String(identity.born + 1), "9"]).status, 2);
    assert.equal(isPidAlive(plain.pid!), true);
    results.push({ mode: "macos-native-identity", exactEnvironment: true, argvSpoofIgnored: true, staleIdentityNotSignaled: true });

    const heldLog = join(root, "held.log");
    logs.push(heldLog);
    const marker = join(root, "held-executed");
    let heldExited = false;
    const held = await spawnAcceptGate({ command: `printf tested > "${marker}"`, cwd: root, logPath: heldLog,
      hold: true, onExit: () => { heldExited = true; } });
    await sleep(150);
    assert.equal(existsSync(marker), false);
    assert.equal(await held.authorize(), true);
    const scope = readGateLaunch(heldLog)!;
    const reopened = macGateConfinement(heldLog, held.pid, held.startedAt, scope.confinementId!);
    const reading = reopened.read();
    assert.equal(reading.kind, "members");
    if (reading.kind === "members") assert.equal(reading.coverage, "observed-processes");
    await until(() => heldExited);
    assert.equal(readFileSync(marker, "utf8"), "tested");
    assert.equal(await stopAcceptGate("macos-test", held.pid, held.startedAt, heldLog), true);
    assert.equal(readGateLaunch(heldLog)?.stoppedEvidence, "observed-empty");
    results.push({ mode: "macos-held-command", commandWaitedForAuthorization: true, executed: true, kernelProofNotClaimed: true });

    const lostLog = join(root, "lost-macos-proof.log");
    logs.push(lostLog);
    const started = await spawnAcceptGate({ command: `"${process.execPath}" -e 'setInterval(() => {}, 1000)'`,
      cwd: root, logPath: lostLog, onExit: () => undefined });
    const path = `${lostLog}.macos-processes.json`;
    const original = readFileSync(path, "utf8");
    backups.set(path, original);
    writeFileSync(path, "invalid evidence");
    assert.equal(gateTreeAlive(started.pid, started.startedAt, lostLog), true);
    assert.equal(await stopAcceptGate("macos-test", started.pid, started.startedAt, lostLog), false);
    assert.equal(readGateLaunch(lostLog)?.phase, "armed");
    writeFileSync(path, original);
    backups.delete(path);
    assert.equal(await stopAcceptGate("macos-test", started.pid, started.startedAt, lostLog), true);
    assert.equal(isPidAlive(plain.pid!), true);
    results.push({ mode: "macos-lost-evidence", missingProofRetainsOwnership: true, restoredProofAllowsStop: true, unrelatedProcessSurvived: true });

    const failureLog = join(root, "macos-command-failed.log");
    logs.push(failureLog);
    let code: number | null | undefined;
    const failed = await spawnAcceptGate({ command: "exit 23", cwd: root, logPath: failureLog, onExit: exit => { code = exit.code; } });
    await until(() => code !== undefined);
    assert.equal(code, 23);
    assert.equal(await stopAcceptGate("macos-test", failed.pid, failed.startedAt, failureLog), true);
    results.push({ mode: "macos-failing-command", exitCode: code, didNotPretendPassed: true });
    return results;
  } finally {
    for (const [path, content] of backups) writeFileSync(path, content);
    for (const log of logs) {
      const launch = readGateLaunch(log);
      await stopAcceptGate("macos-test", launch?.pid, launch?.startedAt, log);
    }
    for (const child of [plain, marked]) {
      if (child.pid && isPidAlive(child.pid)) child.kill("SIGKILL");
    }
  }
}
