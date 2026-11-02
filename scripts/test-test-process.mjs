import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertProcessResult, runTestProcess } from "./test-process.mjs";
import { IS_WINDOWS, isPidAlive } from "./platform.mjs";
import { delay, disposeTestScopesSync, spawnTestFixture } from "./test-process-scope.mjs";
import { cleanupTestResourcesSync, withTestResources } from "./test-process-resources.mjs";

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
let operationError;
try {
  const output = await runTestProcess(process.execPath, ["-e", `
    require('node:fs').writeSync(1, 'x'.repeat(2 * 1024 * 1024) + 'stdout-tail');
    require('node:fs').writeSync(2, 'stderr-tail');
  `]);
  assert.equal(output.stdout, "x".repeat(2 * 1024 * 1024) + "stdout-tail");
  assert.equal(output.stderr, "stderr-tail");
  await runTestProcess(process.execPath, ["-e", "process.exit(2)"], {}, 2);
  await assert.rejects(() => runTestProcess(process.execPath, ["-e", "process.exit(2)"]));
  await assert.rejects(() => runTestProcess(join(temporary, "missing-command"), []), /ENOENT/);
  await assert.rejects(() => runTestProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 200 }), /ETIMEDOUT/);
  if (!IS_WINDOWS) {
    await assert.rejects(() => runTestProcess(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"]), /SIGTERM/);
  }
  const background = join(temporary, "background.cjs");
  const backgroundLog = join(temporary, "background.log");
  writeFileSync(background, `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const inherited = await runTestProcess(process.execPath, ["-e", `
    const output = require('node:fs').openSync(${JSON.stringify(backgroundLog)}, 'a');
    const child = require('node:child_process').spawn(process.execPath,
      [${JSON.stringify(background)}], { detached: true, stdio: ['ignore', output, output] });
    child.unref();
    console.log('stdout-complete');
    console.error('stderr-complete');
  `], { timeout: 5_000, preserveScripts: [background] });
  assert.equal(inherited.stdout.trim(), "stdout-complete");
  assert.equal(inherited.stderr.trim(), "stderr-complete");
  for (let attempt = 0; attempt < 100 && !existsSync(pidPath); attempt++) await delay(20);
  assert.ok(isPidAlive(Number(readFileSync(pidPath, "utf8"))));
  await inherited.dispose();
  assert.ok(!isPidAlive(Number(readFileSync(pidPath, "utf8"))));

  const tails = await runTestProcess(process.execPath, ["-e", `
    require('node:child_process').spawn(process.execPath, ['-e',
      "setTimeout(() => { require('node:fs').writeSync(1, 'late-stdout-tail'); require('node:fs').writeSync(2, 'late-stderr-tail'); }, 600)"],
      { detached: true, stdio: 'inherit' }).unref(); console.log('parent-complete');
  `], { timeout: 5_000 });
  assert.match(tails.stdout, /parent-complete/);
  assert.match(tails.stdout, /late-stdout-tail/);
  assert.match(tails.stderr, /late-stderr-tail/);
  const inheritedService = join(temporary, "inherited-service.cjs");
  writeFileSync(inheritedService, "setInterval(() => {}, 1000)");
  await assert.rejects(() => runTestProcess(process.execPath, ["-e", `
    require('node:child_process').spawn(process.execPath, [${JSON.stringify(inheritedService)}], { detached: true, stdio: 'inherit' }).unref();
  `], { timeout: 800, preserveScripts: [inheritedService] }), /ETIMEDOUT/);

  const sideEffect = join(temporary, "late-side-effect");
  const descendantPid = join(temporary, "descendant.pid");
  const descendant = join(temporary, "descendant.cjs");
  writeFileSync(descendant, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(descendantPid)}, String(process.pid));
    console.log('DIAGNOSTIC_STDOUT'); console.error('DIAGNOSTIC_STDERR');
    setTimeout(() => fs.writeFileSync(${JSON.stringify(sideEffect)}, 'leaked'), 1500); setInterval(() => {}, 1000);`);
  const quote = (value) => "'" + value.replaceAll("'", IS_WINDOWS ? "''" : "'\\''") + "'";
  const shellArgs = IS_WINDOWS ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`& ${quote(process.execPath)} ${quote(descendant)}`, "utf16le").toString("base64")]
    : ["-c", `${quote(process.execPath)} ${quote(descendant)}; exit $?`];
  const sentinel = spawnTestFixture(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await withTestResources(async () => {
    const started = Date.now();
    await assert.rejects(() => runTestProcess(IS_WINDOWS ? "powershell.exe" : "/bin/sh", shellArgs, { timeout: 800 }), (error) => {
      assert.equal(error.code, "ETIMEDOUT");
      assert.match(error.stdout, /DIAGNOSTIC_STDOUT/);
      assert.match(error.stderr, /DIAGNOSTIC_STDERR/);
      assert.ok(error.cause);
      return true;
    });
    assert.ok(Date.now() - started < 15_000);
    assert.ok(!isPidAlive(Number(readFileSync(descendantPid, "utf8"))), "超时后代必须已终止");
    await delay(1_600);
    assert.equal(existsSync(sideEffect), false);
    assert.ok(isPidAlive(sentinel.pid), "不能误杀其他执行域");
    console.log(`✓ shell 超时后代已终止且无延迟副作用,诊断双流保留,其他执行域仍存活 (${Date.now() - started}ms)`);
  }, [() => sentinel.dispose()]);

  if (!IS_WINDOWS) {
    const started = Date.now();
    await assert.rejects(() => runTestProcess(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { timeout: 200 }), /ETIMEDOUT/);
    assert.ok(Date.now() - started < 5_000, "忽略 SIGTERM 也必须有界结束");
    console.log(`✓ 忽略 SIGTERM 的执行在 ${Date.now() - started}ms 内超时并清场`);
  }

  rmSync(descendantPid, { force: true });
  const broken = spawnTestFixture(process.execPath, ["-e", `
    require('node:child_process').spawn(process.execPath, [${JSON.stringify(descendant)}], { detached: true, stdio: 'ignore' }).unref();
    const deadline = Date.now() + 3000;
    while (!require('node:fs').existsSync(${JSON.stringify(descendantPid)}) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    require('node:fs').writeFileSync(${JSON.stringify(join(temporary, "missing-directory", "state"))}, 'unreachable');
  `], { stdio: "ignore" });
  await new Promise((resolveExit) => broken.once("exit", resolveExit));
  await broken.dispose();
  assert.ok(existsSync(descendantPid));
  assert.ok(!isPidAlive(Number(readFileSync(descendantPid, "utf8"))));
} catch (error) { operationError = error; }
finally {
  cleanupTestResourcesSync([disposeTestScopesSync, () => rmSync(temporary, { recursive: true, force: true })], operationError);
}
console.log("✓ 子进程执行域:超时后代/拒绝信号/登记失败均清场,保留诊断及晚写双流,独立日志服务显式登记");
