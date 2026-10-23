import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { powerShellCommandCases } from "./project-command-powershell-cases.js";

function hasErrorOutput(output: string): boolean {
  if (!output.trim().startsWith("#< CLIXML")) return Boolean(output.trim());
  return /<(?:S|Obj)\b[^>]*\bS="Error"/i.test(output)
    || Boolean(output.replace(/#< CLIXML\s*/g, "").replace(/<Objs\b[\s\S]*?<\/Objs>/g, "").trim());
}

assert.equal(hasErrorOutput('#< CLIXML\n<Objs><Obj S="progress"></Obj></Objs>'), false);
assert.equal(hasErrorOutput('#< CLIXML\n<Objs><Obj S="information"></Obj></Objs>'), false);
assert.equal(hasErrorOutput('#< CLIXML\n<Objs><S S="Error">failure</S></Objs>'), true);
assert.equal(hasErrorOutput('#< CLIXML\n<Objs></Objs>native failure'), true);

const platform = process.platform;
const powerShell = process.env.ASH_TEST_POWERSHELL;
if (platform !== "win32" && !powerShell) {
  console.log("PowerShell semantics skipped: requires Windows or ASH_TEST_POWERSHELL");
} else {
  const stage = mkdtempSync(join(tmpdir(), "ash-powershell-command-"));
  const oldPath = process.env.PATH;
  try {
    if (platform !== "win32") {
      symlinkSync(powerShell!, join(stage, "pwsh.exe"));
      process.env.PATH = stage;
      Object.defineProperty(process, "platform", { value: "win32" });
    }
    const { commandLaunch } = await import("../src/terminal-shell.js");
    const { resolveBin } = await import("../src/executors/bin-resolve.js");
    const cases = powerShellCommandCases(process.execPath);
    const plans = cases.map((testCase) => ({ ...testCase, launch: commandLaunch(testCase.script) }));
    const shells = platform === "win32" && !powerShell
      ? [...new Set(["pwsh.exe", "powershell.exe"].map((candidate) => resolveBin(candidate)).filter(Boolean))] as string[]
      : [powerShell ?? plans[0].launch.shell];
    Object.defineProperty(process, "platform", { value: platform });
    process.env.PATH = oldPath;
    for (const shell of shells) {
      const version = spawnSync(shell, ["-NoLogo", "-NoProfile", "-Command", "100 * $PSVersionTable.PSVersion.Major + $PSVersionTable.PSVersion.Minor"], {
        encoding: "utf8", timeout: 20_000, windowsHide: true,
      });
      assert.ifError(version.error);
      assert.equal(version.status, 0, version.stderr);
      const versionNumber = Number(version.stdout.trim());
      assert.ok(versionNumber >= 500, `unexpected PowerShell version: ${version.stdout}`);
      for (const testCase of plans) {
        if ((testCase.minimumVersion ?? 500) > versionNumber) continue;
        const result = spawnSync(shell, testCase.launch.args, {
          encoding: "utf8",
          timeout: 20_000,
          windowsHide: true,
        });
        assert.ifError(result.error);
        assert.equal(result.status, testCase.exitCode, `${testCase.name}: ${result.stderr}`);
        if (testCase.output) assert.ok(result.stdout.includes(testCase.output), `${testCase.name}: ${result.stdout}`);
        assert.equal(hasErrorOutput(result.stderr), Boolean(testCase.error), `${testCase.name}: ${result.stderr}`);
        if (testCase.exitCode === 0) {
          const originalPath = join(stage, `${testCase.name}.ps1`);
          writeFileSync(originalPath, `\ufeff${testCase.script}`, "utf8");
          const invokeOriginal = `& '${originalPath.replace(/'/g, "''")}'`;
          const original = spawnSync(shell, [
            "-NoLogo", "-EncodedCommand", Buffer.from(invokeOriginal, "utf16le").toString("base64"),
          ], { encoding: "utf8", timeout: 20_000, windowsHide: true });
          assert.ifError(original.error);
          assert.equal(original.status, 0, `${testCase.name} original: ${original.stderr}`);
          assert.equal(hasErrorOutput(original.stderr), false, `${testCase.name} original: ${original.stderr}`);
          assert.equal(result.stdout, original.stdout, `${testCase.name}: complete script output changed`);
        }
        console.log(`PowerShell semantics passed (${shell}): ${testCase.name}`);
      }
    }
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
    process.env.PATH = oldPath;
    rmSync(stage, { recursive: true, force: true });
  }
}
