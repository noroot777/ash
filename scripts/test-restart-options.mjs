import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NPM, NPM_SPAWN_OPTS } from "./npm.mjs";
import { parseRestartOptions, restartCommand, RESTART_USAGE } from "./restart-options.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const defaults = { force: false, wait: false, skipMcp: false, forceMcp: false, help: false };
assert.equal(restartCommand("--force"), "node scripts/restart.mjs --force");
assert.ok(RESTART_USAGE.startsWith(`用法: ${restartCommand()} [选项]`));
assert.deepEqual(parseRestartOptions([], {}), defaults);
for (const [flag, field, variable] of [
  ["--force", "force", "FORCE"],
  ["--wait", "wait", "WAIT"],
  ["--skip-mcp", "skipMcp", "SKIP_MCP"],
  ["--force-mcp", "forceMcp", "FORCE_MCP"],
]) {
  assert.deepEqual(parseRestartOptions([flag], {}), { ...defaults, [field]: true });
  assert.deepEqual(parseRestartOptions([], { [variable]: "1" }), { ...defaults, [field]: true });
  assert.deepEqual(parseRestartOptions([], { [variable]: "0" }), { ...defaults, [field]: true });
  assert.deepEqual(parseRestartOptions([], { [variable]: "" }), defaults);
}
assert.deepEqual(parseRestartOptions(["--force", "--skip-mcp"], { WAIT: "1", FORCE_MCP: "1" }), {
  force: true, wait: true, skipMcp: true, forceMcp: true, help: false,
});
for (const flag of ["--help", "-h"]) {
  assert.deepEqual(parseRestartOptions([flag], {}), { ...defaults, help: true });
}
for (const args of [["--froce"], ["force"], ["--force=false"], ["--force", "false"]]) {
  assert.throws(() => parseRestartOptions(args, {}));
}

const restart = fileURLToPath(new URL("./restart.mjs", import.meta.url));
const help = spawnSync(NPM, ["run", "restart", "--", "--help"], {
  ...NPM_SPAWN_OPTS, cwd: repo, encoding: "utf8", timeout: 30_000,
});
assert.equal(help.status, 0, help.stdout + help.stderr);
assert.match(help.stdout, /--force/);
assert.match(help.stdout, /--wait/);
assert.match(help.stdout, /--skip-mcp/);
assert.match(help.stdout, /--force-mcp/);
assert.doesNotMatch(help.stdout, /▶|✅ 完成/);
for (const argument of ["--froce", "force"]) {
  const invalid = spawnSync(process.execPath, [restart, argument], {
    cwd: repo, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(invalid.status, 2, invalid.stdout + invalid.stderr);
  assert.match(invalid.stderr, /--help/);
  assert.doesNotMatch(invalid.stdout, /▶|✅ 完成/);
}

const temporary = mkdtempSync(join(tmpdir(), "ash-restart-argv-"));
try {
  const guard = join(temporary, "argv-guard.cjs");
  writeFileSync(guard, `if (/[/\\\\]restart\\.mjs$/.test(process.argv[1] || '')) {
    console.log('RESTART_ARGV=' + JSON.stringify(process.argv.slice(2)));
    process.exit(0);
  }`);
  const cases = [
    ["--force"], ["--wait"], ["--skip-mcp"], ["--force-mcp"],
    ["--help"], ["-h"], ["--froce"],
    ["--force", "--wait", "--skip-mcp", "--force-mcp"],
  ];
  for (const args of cases) {
    const commands = [restartCommand(...args)];
    if (process.platform === "win32") commands.push(`npm.cmd run restart -- ${args.join(" ")}`);
    for (const command of commands) {
      const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
      const shellArgs = process.platform === "win32"
        ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")]
        : ["-c", command];
      const probe = spawnSync(shell, shellArgs, {
        cwd: repo, encoding: "utf8", timeout: 30_000,
        env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(guard.replaceAll("\\", "/"))}` },
      });
      assert.equal(probe.error, undefined, `${command}: ${probe.error?.message}`);
      assert.equal(probe.status, 0, `${command}: ${probe.stdout}${probe.stderr}`);
      const match = /RESTART_ARGV=(\[[^\r\n]*\])/.exec(probe.stdout);
      assert.ok(match, `${command}: restart 未收到参数: ${probe.stdout}${probe.stderr}`);
      assert.deepEqual(JSON.parse(match[1]), args, command);
    }
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
process.stdout.write("✓ restart 参数兼容环境变量, 真实 shell 完整透传全部选项, 错误参数在构建/重启前中止\n");
