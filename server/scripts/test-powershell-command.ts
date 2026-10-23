import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { powerShellCommandCases } from "./project-command-powershell-cases.js";

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
      for (const testCase of plans) {
        const result = spawnSync(shell, testCase.launch.args, {
          encoding: "utf8",
          timeout: 20_000,
          windowsHide: true,
        });
        assert.ifError(result.error);
        assert.equal(result.status, testCase.exitCode, `${testCase.name}: ${result.stderr}`);
        if (testCase.output) assert.ok(result.stdout.includes(testCase.output), `${testCase.name}: ${result.stdout}`);
        assert.equal(Boolean(result.stderr.trim()), Boolean(testCase.error), `${testCase.name}: ${result.stderr}`);
        if (testCase.exitCode === 0) {
          const original = spawnSync(shell, [
            "-NoLogo", "-EncodedCommand", Buffer.from(testCase.script, "utf16le").toString("base64"),
          ], { encoding: "utf8", timeout: 20_000, windowsHide: true });
          assert.ifError(original.error);
          assert.equal(original.status, 0, `${testCase.name} original: ${original.stderr}`);
          assert.equal(original.stderr.trim(), "", `${testCase.name} original: ${original.stderr}`);
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
