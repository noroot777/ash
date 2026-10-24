import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gateTreeAlive, spawnAcceptGate, stopAcceptGate, type GateExit } from "../src/accept-gate-process.js";
import { readGateLaunch } from "../src/accept-gate-launch.js";
import { IS_WINDOWS, isPidAlive, userShellLaunch } from "../src/platform.js";

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

{
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
  const child = spawn(process.execPath, [__filename, "child"], {
    stdio: "ignore", detached: process.platform === "win32", windowsHide: true
  });
  child.unref();
  ${mode === "normal" ? "setInterval(() => {}, 1000);" : `setInterval(() => {
    if (fs.existsSync(${JSON.stringify(pulseFile)})) process.exit(0);
  }, 10);`}
}
`);
    let exited = false;
    const started = spawnAcceptGate({ command: `"${process.execPath}" "${script}"`, cwd: root, logPath,
      onExit: () => { exited = true; } });
    try {
      await until(() => existsSync(pidFile) && existsSync(pulseFile));
      if (mode !== "normal") await until(() => exited);
      const childPid = Number(readFileSync(pidFile, "utf8"));
      const leaderAliveBeforeStop = isPidAlive(started.pid);
      assert.equal(leaderAliveBeforeStop, mode === "normal");
      assert.equal(isPidAlive(childPid), true);
      const pulseBefore = readFileSync(pulseFile, "utf8");
      await until(() => readFileSync(pulseFile, "utf8") !== pulseBefore);
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
      results.push({ mode, pid: started.pid, childPid, leaderAliveBeforeStop, stopped, childStillWriting: false });
    } finally {
      assert.equal(await stopAcceptGate("process-test", started.pid, started.startedAt, logPath), true);
    }
  }
  console.log(JSON.stringify({ platform: process.platform, results }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
}

{
const root = mkdtempSync(join(tmpdir(), "ash-gate-process-"));
let runNumber = 0;

async function run(command: string): Promise<{ exit: GateExit; log: string }> {
  const logPath = join(root, `gate-${runNumber++}.log`);
  const exit = await new Promise<GateExit>((resolve, reject) => {
    let processInfo: ReturnType<typeof spawnAcceptGate> | undefined;
    const timer = setTimeout(() => {
      void stopAcceptGate("process-test", processInfo?.pid, processInfo?.startedAt, logPath);
      reject(new Error(`门禁命令超时: ${command}`));
    }, 20_000);
    try {
      processInfo = spawnAcceptGate({
        command, cwd: root, logPath,
        onExit: (result) => { clearTimeout(timer); resolve(result); },
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
  return { exit, log: readFileSync(logPath, "utf8") };
}

try {
  const plain = await run('node -e "console.log(123); process.exit(7)"');
  assert.equal(plain.exit.code, 7);
  assert.match(plain.log, /123/);
  if (!IS_WINDOWS) {
    assert.deepEqual(userShellLaunch("./kb.ps1 test full"), { file: "sh", args: ["-lc", "./kb.ps1 test full"] });
  } else {
    writeFileSync(join(root, "kb.ps1"), [
      'param([string]$Action, [string]$Scope)',
      '[Console]::WriteLine("GATE_ARGS=$Action|$Scope")',
      '[IO.File]::WriteAllText((Join-Path $PWD "proof.json"), (@{ cwd = [string]$PWD; action = $Action; scope = $Scope } | ConvertTo-Json))',
      'exit 0',
    ].join("\r\n"), "utf8");
    const passed = await run('.\\kb.ps1 test full');
    assert.equal(passed.exit.code, 0, passed.log);
    assert.match(passed.log, /GATE_ARGS=test\|full/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "proof.json"), "utf8")), {
      cwd: root, action: "test", scope: "full",
    });
    const unicode = await run('.\\KB.PS1 test "全量 回归"');
    assert.equal(unicode.exit.code, 0, unicode.log);
    assert.match(unicode.log, /GATE_ARGS=test\|全量 回归/);
    assert.equal(JSON.parse(readFileSync(join(root, "proof.json"), "utf8")).scope, "全量 回归");

    const scripts = join(root, "scripts with spaces");
    mkdirSync(scripts);
    writeFileSync(join(scripts, "kb.ps1"), '[Console]::WriteLine("QUOTED=" + $args[0]); exit 23', "utf8");
    for (const command of [
      '".\\scripts with spaces\\kb.ps1" "full suite"',
      "& '.\\scripts with spaces\\kb.ps1' 'full suite'",
    ]) {
      const failed = await run(command);
      assert.equal(failed.exit.code, 23, failed.log);
      assert.match(failed.log, /QUOTED=full suite/);
    }

    writeFileSync(join(root, "native.ps1"), 'node -e "process.exit(17)"', "utf8");
    assert.equal((await run('.\\native.ps1')).exit.code, 17);
    writeFileSync(join(root, "success.ps1"), 'Write-Output "GATE_SUCCESS"', "utf8");
    const success = await run('.\\success.ps1');
    assert.equal(success.exit.code, 0, success.log);
    assert.match(success.log, /GATE_SUCCESS/);
    writeFileSync(join(root, "error.ps1"), 'Write-Error "GATE_FAILURE"', "utf8");
    const errored = await run('.\\error.ps1');
    assert.notEqual(errored.exit.code, 0, errored.log);
    assert.match(errored.log, /GATE_FAILURE/);
    assert.notEqual((await run('.\\missing.ps1 test full')).exit.code, 0);
    assert.equal((await run('node -e "process.exit(0)" && node -e "process.exit(9)"')).exit.code, 9);
  }
  console.log(`✅ 验收命令进程（${IS_WINDOWS ? "Windows ps1/参数/工作目录/退出码/异常/cmd 兼容" : "POSIX shell/日志/退出码"}）通过`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
}
