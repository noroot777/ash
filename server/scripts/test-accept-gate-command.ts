import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAcceptGate, stopAcceptGate, type GateExit } from "../src/accept-gate-process.js";
import { IS_WINDOWS, userShellLaunch } from "../src/platform.js";

const root = mkdtempSync(join(tmpdir(), "ash-gate-process-"));
let runNumber = 0;
const launches: { logPath: string; pid?: number; startedAt?: string | null }[] = [];

async function run(command: string): Promise<{ exit: GateExit; log: string }> {
  const logPath = join(root, `gate-${runNumber++}.log`);
  const launch: typeof launches[number] = { logPath };
  launches.push(launch);
  const exit = await new Promise<GateExit>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`门禁命令超时: ${command}`)), 20_000);
    try {
      Object.assign(launch, spawnAcceptGate({
        command, cwd: root, logPath,
        onExit: (result) => { clearTimeout(timer); resolve(result); },
      }));
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
    for (const testCase of [
      { name: "recovered", script: 'node -e "process.exit(7)"\nWrite-Output "RECOVERED"', code: 0 },
      { name: "native-failure", script: 'node -e "process.exit(19)"', code: 19 },
      { name: "cmdlet-failure", script: 'Write-Error "CMDLET_FAILURE"', code: 1 },
      { name: "throw", script: 'throw "THROWN_FAILURE"', code: 1 },
      { name: "explicit-success", script: 'node -e "process.exit(7)"\nexit 0', code: 0 },
      { name: "explicit-failure", script: 'Write-Output "BEFORE_EXIT"\nexit 23', code: 23 },
      { name: "nested-failure", script: '& .\\native.ps1', code: 17 },
      { name: "nested-recovery", script: '& .\\native.ps1\nWrite-Output "RECOVERED"', code: 0 },
      { name: "nested-explicit-exit", script: '& .\\explicit-failure.ps1', code: 23 },
      { name: "command-object-failure", script: '$child = Get-Command .\\native.ps1\n& $child', code: 17 },
      { name: "command-object-cached-failure", script: '$child = Get-Command .\\native.ps1\n& $child\n& $child', code: 17 },
      { name: "command-object-expression", script: '& (Get-Command .\\native.ps1)', code: 17 },
      { name: "command-object-recovery", script: '$child = Get-Command .\\native.ps1\n& $child\nWrite-Output "OBJECT_RECOVERED"', code: 0 },
      { name: "command-object-recovered-child", script: '& (Get-Command .\\recovered.ps1)', code: 0 },
      { name: "command-object-explicit-success", script: '& (Get-Command .\\explicit-success.ps1)', code: 0 },
      { name: "command-object-explicit-failure", script: '& (Get-Command .\\explicit-failure.ps1)', code: 23 },
      { name: "command-object-dot-source", script: '$child = Get-Command .\\native.ps1\n. $child', code: 17 },
      { name: "command-object-alias", script: 'Set-Alias -Name Invoke-ChildScript -Value .\\native.ps1\n& (Get-Command Invoke-ChildScript)', code: 17 },
      { name: "command-object-throw", script: '& (Get-Command .\\throw.ps1)', code: 1 },
      { name: "blocks-end-before-begin", script: 'end { Write-Output "END_OK" }\nbegin { Write-Output "BEGIN_OK" }', code: 0 },
      { name: "blocks-failure-end-before-begin", script: 'end { & .\\native.ps1 }\nbegin { Write-Output "BEGIN_OK" }', code: 17 },
    ]) {
      writeFileSync(join(root, `${testCase.name}.ps1`), testCase.script, "utf8");
      const result = await run(`.\\${testCase.name}.ps1`);
      assert.equal(result.exit.code, testCase.code, `${testCase.name}: ${result.log}`);
      if (testCase.name === "recovered") assert.match(result.log, /RECOVERED/);
    }
    assert.equal((await run('.\\success.ps1; .\\native.ps1')).exit.code, 17);
    assert.equal((await run('.\\native.ps1; .\\success.ps1')).exit.code, 0);
    assert.equal((await run('.\\success.ps1; .\\explicit-failure.ps1')).exit.code, 23);
    writeFileSync(join(root, "error.ps1"), 'Write-Error "GATE_FAILURE"', "utf8");
    const errored = await run('.\\error.ps1');
    assert.notEqual(errored.exit.code, 0, errored.log);
    assert.match(errored.log, /GATE_FAILURE/);
    assert.notEqual((await run('.\\missing.ps1 test full')).exit.code, 0);
    assert.equal((await run('node -e "process.exit(0)" && node -e "process.exit(9)"')).exit.code, 9);
  }
  console.log(`✅ 验收命令进程（${IS_WINDOWS ? "Windows ps1/参数/工作目录/退出码/异常/cmd 兼容" : "POSIX shell/日志/退出码"}）通过`);
} finally {
  for (const launch of launches) {
    assert.equal(await stopAcceptGate("process-test", launch.pid, launch.startedAt, launch.logPath), true);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
