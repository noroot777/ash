import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gateTreeAlive, spawnAcceptGate, stopAcceptGate } from "../src/accept-gate-process.js";
import { readGateLaunch } from "../src/accept-gate-launch.js";

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error("gate process condition timed out");
}

if (process.argv[2] === "recover-worker") {
  const stopped = await stopAcceptGate("process-test", null, null, process.argv[3]);
  console.log(JSON.stringify({ stopped }));
  process.exit(stopped ? 0 : 1);
}

const root = mkdtempSync(join(tmpdir(), "ash-gate-process-"));
const results: object[] = [];
try {
  for (const mode of ["normal", "orphan", "reopen"]) {
    const directory = join(root, mode);
    const script = `${directory}.cjs`;
    const pidFile = `${directory}.pid`;
    const pulseFile = `${directory}.pulse`;
    const logPath = `${directory}.log`;
    writeFileSync(script, `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
if (process.argv[2] === "child") {
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  setInterval(() => fs.appendFileSync(${JSON.stringify(pulseFile)}, "pulse\\n"), 40);
} else {
  const child = spawn(process.execPath, [__filename, "child"], { stdio: "ignore" });
  child.unref();
  ${mode === "normal" ? "setInterval(() => {}, 1000);" : "process.exit(0);"}
}
`);
    let exited = false;
    const started = spawnAcceptGate({ command: `"${process.execPath}" "${script}"`, cwd: root, logPath,
      onExit: () => { exited = true; } });
    try {
      await until(() => existsSync(pidFile) && existsSync(pulseFile));
      if (mode !== "normal") await until(() => exited);
      const childPid = Number(readFileSync(pidFile, "utf8"));
      assert.equal(gateTreeAlive(started.pid, started.startedAt, logPath), true);
      let stopped: boolean;
      if (mode === "reopen") {
        const worker = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "recover-worker", logPath],
          { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        worker.stdout?.on("data", chunk => { stdout += String(chunk); });
        worker.stderr?.on("data", chunk => { stderr += String(chunk); });
        const code = await new Promise(resolve => worker.once("exit", resolve));
        assert.equal(code, 0, stderr || stdout);
        stopped = JSON.parse(stdout.trim().split("\n").at(-1)!).stopped;
      } else stopped = await stopAcceptGate("process-test", started.pid, started.startedAt, logPath);
      assert.equal(stopped, true);
      const pulse = readFileSync(pulseFile, "utf8");
      await sleep(160);
      assert.equal(readFileSync(pulseFile, "utf8"), pulse, "停止返回后后代不能继续写文件");
      assert.equal(readGateLaunch(logPath)?.phase, "stopped");
      assert.equal(gateTreeAlive(started.pid, started.startedAt, logPath), false);
      results.push({ mode, pid: started.pid, childPid, stopped, childStillWriting: false });
    } finally {
      assert.equal(await stopAcceptGate("process-test", started.pid, started.startedAt, logPath), true);
    }
  }
  console.log(JSON.stringify({ platform: process.platform, results }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
