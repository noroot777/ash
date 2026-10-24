import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertProcessResult, runTestProcess } from "./test-process.mjs";
import { IS_WINDOWS, isPidAlive, killPid } from "./platform.mjs";

const complete = { status: 0, signal: null, stdout: "已就绪\n✅ 完成\n", stderr: "" };
assert.equal(assertProcessResult(complete), complete);
assertProcessResult({ ...complete, status: 2 }, 2);
for (const expectedStatus of [0, 1, 2]) {
  const error = Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" });
  assert.throws(() => assertProcessResult({ ...complete, status: expectedStatus, error }, expectedStatus), /ETIMEDOUT/);
}
for (const result of [
  { ...complete, signal: "SIGTERM" },
  { ...complete, status: null },
  { ...complete, status: 1 },
  { ...complete, stdout: null },
  { ...complete, stderr: null },
]) assert.throws(() => assertProcessResult(result));

const temporary = mkdtempSync(join(tmpdir(), "ash-test-process-fixture-"));
const pidPath = join(temporary, "child.pid");
try {
  const output = runTestProcess(process.execPath, ["-e", `
    require('node:fs').writeSync(1, 'x'.repeat(2 * 1024 * 1024) + 'stdout-tail');
    require('node:fs').writeSync(2, 'stderr-tail');
  `]);
  assert.equal(output.stdout, "x".repeat(2 * 1024 * 1024) + "stdout-tail");
  assert.equal(output.stderr, "stderr-tail");
  runTestProcess(process.execPath, ["-e", "process.exit(2)"], {}, 2);
  assert.throws(() => runTestProcess(process.execPath, ["-e", "process.exit(2)"]));
  assert.throws(() => runTestProcess(join(temporary, "missing-command"), []), /ENOENT/);
  assert.throws(() => runTestProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 200 }), /ETIMEDOUT/);
  if (!IS_WINDOWS) {
    assert.throws(() => runTestProcess(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"]), /SIGTERM/);
  }
  const inherited = runTestProcess(process.execPath, ["-e", `
    const child = require('node:child_process').spawn(process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'inherit' });
    require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
    child.unref();
    console.log('stdout-complete');
    console.error('stderr-complete');
  `], { timeout: 5_000 });
  assert.equal(inherited.stdout.trim(), "stdout-complete");
  assert.equal(inherited.stderr.trim(), "stderr-complete");
  assert.ok(isPidAlive(Number(readFileSync(pidPath, "utf8"))));
} finally {
  if (existsSync(pidPath)) killPid(Number(readFileSync(pidPath, "utf8")));
  rmSync(temporary, { recursive: true, force: true });
}
console.log("✓ 子进程完整结果校验:拒绝零退出码超时/异常信号,完整收集双流,继承输出句柄不阻塞退出");
