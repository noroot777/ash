import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBin } from "../src/executors/bin-resolve.js";
import { IS_WINDOWS, userShellLaunch } from "../src/platform.js";
import { powerShellCommandCases } from "./project-command-powershell-cases.js";

if (!IS_WINDOWS) {
  console.log("PowerShell file semantics skipped: requires Windows");
} else {
  const root = mkdtempSync(join(tmpdir(), "ash-user-shell-powershell-"));
  const directory = join(root, "scripts with spaces");
  mkdirSync(directory);
  const scriptPath = join(directory, "case.ps1");
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const invocation = `& ${quote(scriptPath)}`;
  const shells = [...new Set(["pwsh.exe", "powershell.exe"].map(resolveBin).filter(Boolean))] as string[];
  assert.ok(shells.length);
  try {
    for (const shell of shells) {
      const version = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "100 * $PSVersionTable.PSVersion.Major + $PSVersionTable.PSVersion.Minor"], {
        encoding: "utf8", windowsHide: true, timeout: 20_000,
      });
      assert.ifError(version.error);
      assert.equal(version.status, 0, version.stderr);
      const versionNumber = Number(version.stdout.trim());
      assert.ok(versionNumber >= 500);
      const cases: Array<ReturnType<typeof powerShellCommandCases>[number] & { arguments?: string }> = [
        ...powerShellCommandCases(process.execPath),
        { name: "empty", script: "", exitCode: 0 },
        { name: "requires-rejected", script: '#requires -Version 999.0\nWrite-Output "MUST_NOT_RUN"', exitCode: 1, absentOutput: "MUST_NOT_RUN" },
        {
          name: "script-context-and-arguments",
          script: `param([string]$Name)\nif ($PSScriptRoot -ne ${quote(directory)} -or $PSCommandPath -ne ${quote(scriptPath)} -or $MyInvocation.MyCommand.Path -ne ${quote(scriptPath)}) { throw "Script context changed" }\nWrite-Output "$Name|$($args[0])"`,
          arguments: ' -Name "全量 回归" "extra arg"',
          exitCode: 0, output: "全量 回归|extra arg",
        },
        { name: "outer-recovery", script: 'node -e "process.exit(7)"', arguments: '; Write-Output "OUTER_RECOVERED"', exitCode: 0, output: "OUTER_RECOVERED" },
        { name: "outer-native-failure", script: 'Write-Output "INNER_OK"', arguments: '; node -e "process.exit(19)"', exitCode: 19 },
        { name: "explicit-exit-then-recovery", script: "exit 23", arguments: '; Write-Output "OUTER_RECOVERED"', exitCode: 0, output: "OUTER_RECOVERED" },
        { name: "pipeline", script: 'node -e "process.exit(7)"\nWrite-Output "PIPELINE_OK"', arguments: " | ForEach-Object { $_ }", exitCode: 0, output: "PIPELINE_OK" },
      ];
      for (const testCase of cases) {
        if ((testCase.minimumVersion ?? 500) > versionNumber) continue;
        writeFileSync(scriptPath, `\ufeff${testCase.script}`, "utf8");
        const launch = userShellLaunch(invocation + (testCase.arguments ?? ""));
        const result = spawnSync(shell, launch.args, { cwd: root, encoding: "utf8", timeout: 20_000, windowsHide: true });
        assert.ifError(result.error);
        assert.equal(result.status, testCase.exitCode, `${testCase.name}: ${result.stdout}\n${result.stderr}`);
        if (testCase.output) assert.ok(result.stdout.includes(testCase.output), `${testCase.name}: ${result.stdout}`);
        if (testCase.absentOutput) assert.ok(!result.stdout.includes(testCase.absentOutput), `${testCase.name}: ${result.stdout}`);
        console.log(`PowerShell file semantics passed (${shell}): ${testCase.name}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
