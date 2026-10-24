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
  const child = (name: string) => `& ${quote(join(directory, `${name}.ps1`))}`;
  const native = (code: number) => `& ${quote(process.execPath)} -e 'process.exit(${code})'`;
  writeFileSync(join(directory, "child-failure.ps1"), native(7), "utf8");
  writeFileSync(join(directory, "child-success.ps1"), 'Write-Output "CHILD_OK"', "utf8");
  writeFileSync(join(directory, "child-recovery.ps1"), `${native(7)}\nWrite-Output "CHILD_RECOVERED"`, "utf8");
  writeFileSync(join(directory, "child-exit.ps1"), "exit 23", "utf8");
  writeFileSync(join(directory, "child-throw.ps1"), 'throw "CHILD_THROW"', "utf8");
  writeFileSync(join(directory, "child-requires.ps1"), '#requires -Version 999.0\nWrite-Output "MUST_NOT_RUN"', "utf8");
  writeFileSync(join(directory, "child-context.ps1"), `param([string]$Name)\nif ($PSScriptRoot -ne ${quote(directory)} -or $PSCommandPath -ne ${quote(join(directory, "child-context.ps1"))} -or $MyInvocation.MyCommand.Path -ne ${quote(join(directory, "child-context.ps1"))}) { throw "Child context changed" }\nWrite-Output $Name`, "utf8");
  writeFileSync(join(directory, "recursive.ps1"), `param([int]$Depth)\nif ($Depth -gt 0) { & $PSCommandPath ($Depth - 1) } else { ${native(7)} }`, "utf8");
  const blockOrders = [
    ["begin", "process"], ["process", "begin"], ["begin", "end"], ["end", "begin"], ["process", "end"], ["end", "process"],
    ["begin", "process", "end"], ["begin", "end", "process"], ["process", "begin", "end"],
    ["process", "end", "begin"], ["end", "begin", "process"], ["end", "process", "begin"],
  ];
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
        { name: "nested-failure", script: child("child-failure"), exitCode: 7 },
        { name: "recursive-failure", script: `${child("recursive")} 3`, exitCode: 7 },
        { name: "nested-recovery", script: `${child("child-failure")}\nWrite-Output "RECOVERED"`, exitCode: 0, output: "RECOVERED" },
        { name: "nested-assignment-recovery", script: `${child("child-failure")}\n$recovered = 1`, exitCode: 0 },
        { name: "nested-success-after-failure", script: `${child("child-failure")}\n${child("child-success")}`, exitCode: 0, output: "CHILD_OK" },
        { name: "nested-recovered-child", script: child("child-recovery"), exitCode: 0, output: "CHILD_RECOVERED" },
        { name: "nested-explicit-exit", script: child("child-exit"), exitCode: 23 },
        { name: "nested-explicit-exit-recovery", script: `${child("child-exit")}\nWrite-Output "RECOVERED"`, exitCode: 0, output: "RECOVERED" },
        { name: "nested-throw", script: child("child-throw"), exitCode: 1 },
        { name: "nested-requires", script: child("child-requires"), exitCode: 1, absentOutput: "MUST_NOT_RUN" },
        { name: "nested-context", script: `${child("child-context")} -Name "CHILD_CONTEXT_OK"`, exitCode: 0, output: "CHILD_CONTEXT_OK" },
        { name: "dynamic-nested-failure", script: `$childPath = ${quote(join(directory, "child-failure.ps1"))}\n& $childPath`, exitCode: 7 },
        { name: "strict-nested-failure", script: `Set-StrictMode -Version Latest\n${child("child-failure")}`, exitCode: 7 },
        { name: "strict-nested-recovery", script: `Set-StrictMode -Version Latest\n${child("child-failure")}\nWrite-Output "STRICT_RECOVERED"`, exitCode: 0, output: "STRICT_RECOVERED" },
        { name: "consecutive-failure", script: 'Write-Output "FIRST_OK"', arguments: `; ${child("child-failure")}`, exitCode: 7, output: "FIRST_OK" },
        { name: "consecutive-recovery", script: native(7), arguments: `; ${child("child-success")}`, exitCode: 0, output: "CHILD_OK" },
        { name: "consecutive-recovered-child", script: native(7), arguments: `; ${child("child-recovery")}`, exitCode: 0, output: "CHILD_RECOVERED" },
        { name: "consecutive-explicit-exit", script: 'Write-Output "FIRST_OK"', arguments: `; ${child("child-exit")}`, exitCode: 23 },
        { name: "outer-explicit-exit", script: 'Write-Output "FIRST_OK"', arguments: "; exit 29", exitCode: 29 },
        { name: "nested-exit-expression", script: 'exit (& { exit 23 })', exitCode: 23 },
        { name: "exported-function-explicit-exit", script: 'function global:Exit-Result { exit 23 }\nWrite-Output "DEFINED"', arguments: "; Exit-Result", exitCode: 23 },
        { name: "begin-explicit-exit", script: 'end { Write-Output "MUST_NOT_RUN" }\nbegin { exit 23 }', exitCode: 23, absentOutput: "MUST_NOT_RUN" },
        { name: "process-explicit-exit", script: 'process { exit 23 }\nend { Write-Output "MUST_NOT_RUN" }', exitCode: 23, absentOutput: "MUST_NOT_RUN" },
        { name: "dot-source-failure", script: `. ${quote(join(directory, "child-failure.ps1"))}`, exitCode: 7 },
        { name: "dot-source-recovery", script: `. ${quote(join(directory, "child-failure.ps1"))}\nWrite-Output "DOT_RECOVERED"`, exitCode: 0, output: "DOT_RECOVERED" },
        { name: "pipeline-native-failure", script: native(7), arguments: " | Out-String", exitCode: 7 },
        { name: "pipeline-native-tee-failure", script: native(7), arguments: " | Tee-Object -Variable captured", exitCode: 7 },
        { name: "pipeline-explicit-exit", script: "exit 23", arguments: " | Out-String", exitCode: 23 },
        { name: "empty-end-failure", script: `end {}\nbegin { ${native(7)} }`, exitCode: 7 },
        { name: "finally-recovery", script: `try { ${child("child-failure")} } finally { Write-Output "FINALLY_OK" }`, exitCode: 0, output: "FINALLY_OK" },
        { name: "finally-failure", script: `try { Write-Output "FIRST_OK" } finally { ${child("child-failure")} }`, exitCode: 7 },
        ...blockOrders.flatMap((order) => [
          { name: `blocks-${order.join("-")}`, script: order.map((block) => `${block} { Write-Output "${block.toUpperCase()}_OK" }`).join("\n"), exitCode: 0, output: order.includes("end") ? "END_OK" : "PROCESS_OK" },
          { name: `blocks-failure-${order.join("-")}`, script: order.map((block) => `${block} { ${block === (order.includes("end") ? "end" : "process") ? native(7) : 'Write-Output "FIRST_OK"'} }`).join("\n"), exitCode: 7 },
        ]),
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
      writeFileSync(scriptPath, 'Write-Output "MUST_NOT_RUN"', "utf8");
      const injectedLaunch = userShellLaunch(invocation);
      const payload = Buffer.from(injectedLaunch.args.at(-1)!, "base64").toString("utf16le");
      const compileReturn = "  $rewritten.GetScriptBlock()";
      assert.ok(payload.includes(compileReturn));
      injectedLaunch.args[injectedLaunch.args.length - 1] = Buffer.from(payload.replace(compileReturn, "  if ($file) { throw 'INSTRUMENTATION_FAILURE' }; $rewritten.GetScriptBlock()"), "utf16le").toString("base64");
      const injected = spawnSync(shell, injectedLaunch.args, { cwd: root, encoding: "utf8", timeout: 20_000, windowsHide: true });
      assert.ifError(injected.error);
      assert.equal(injected.status, 1, injected.stderr);
      assert.ok(!injected.stdout.includes("MUST_NOT_RUN"), injected.stdout);
      assert.match(injected.stderr, /INSTRUMENTATION_FAILURE/);
      console.log(`PowerShell file semantics passed (${shell}): instrumentation-fails-closed`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
