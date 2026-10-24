import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NPM, NPM_SPAWN_OPTS } from "./npm.mjs";
import { parseRestartOptions } from "./restart-options.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const defaults = { force: false, wait: false, skipMcp: false, forceMcp: false, help: false };
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
process.stdout.write("✓ restart 参数兼容环境变量, npm 透传帮助, 错误参数在构建/重启前中止\n");
