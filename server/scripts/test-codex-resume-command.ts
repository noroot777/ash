import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { resumeCommandFor } from "../src/executors/resume.js";
import { shq } from "../src/executors/spawn.js";

const windows = process.platform === "win32";
const root = mkdtempSync(join(tmpdir(), "ash-archive-command-"));
const home = join(root, "user's codex home");
const cwd = join(root, "work space");
const log = join(root, "calls.jsonl");
const stub = join(root, "codex-stub.cjs");
mkdirSync(home);
mkdirSync(cwd);
writeFileSync(stub, `
const fs = require('node:fs');
fs.appendFileSync(process.env.ASH_RESUME_FIXTURE_LOG, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(), home: process.env.CODEX_HOME, key: process.env.ASH_RELAY_KEY,
}) + '\\n');
if (process.argv[2] === 'unarchive' && process.env.ASH_RESUME_FIXTURE_FAIL === '1') process.exit(41);
`);
writeFileSync(join(root, windows ? "codex.cmd" : "codex"), windows
  ? `@echo off\r\n"${process.execPath}" "${stub}" %*\r\n`
  : `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(stub)} "$@"\n`, { mode: 0o755 });
const command = resumeCommandFor("codex", cwd, "fixture-thread", "ASH_RELAY_KEY=placeholder ", null, { configDir: home });
const env = { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ""}`, ASH_RESUME_FIXTURE_LOG: log };
const hiddenConsoleGuard = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AshConsoleWindow { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle); }'
if ([AshConsoleWindow]::IsWindowVisible([AshConsoleWindow]::GetConsoleWindow())) { [Console]::Error.WriteLine('spawned PowerShell console is visible'); exit 97 }
`;
const run = (fail: boolean) => windows
  ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(`${hiddenConsoleGuard}${command}; exit $LASTEXITCODE`, "utf16le").toString("base64")],
    { env: { ...env, ASH_RESUME_FIXTURE_FAIL: fail ? "1" : "0" }, windowsHide: true })
  : spawnSync("sh", ["-c", command], { env: { ...env, ASH_RESUME_FIXTURE_FAIL: fail ? "1" : "0" } });
try {
  const success = run(false);
  assert.equal(success.status, 0, success.stderr?.toString());
  const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.args), [["unarchive", "fixture-thread"], ["resume", "fixture-thread"]]);
  assert.ok(calls.every((call) => call.home === home && call.key === "placeholder"));
  assert.ok(calls.every((call) => call.cwd.toLowerCase().endsWith("work space")));
  writeFileSync(log, "");
  assert.equal(run(true).status, 41);
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1, "恢复失败不进入 resume");
  console.log(`✓ ${windows ? "PowerShell" : "POSIX shell"} 实际执行复制命令：先恢复再接手，同一配置/供应商，空格与引号路径保留`);
} finally { rmSync(root, { recursive: true, force: true }); }
