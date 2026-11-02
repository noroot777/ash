import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestProcessScope, delay, disposeTestProcessResourcesSync } from "./test-process-scope.mjs";
import { runTestProcess } from "./test-process.mjs";
import native from "./test-process-native.cjs";

const temporary = fs.mkdtempSync(join(tmpdir(), "ash-test-lifecycle-"));
const original = { invoke: native.invoke, spawn: childProcess.spawn, existsSync: fs.existsSync, now: Date.now };
const owned = [];
const makeScope = () => { const scope = new TestProcessScope(); owned.push(scope); return scope; };
try {
  const vanished = makeScope();
  fs.rmSync(vanished.directory, { recursive: true });
  const restored = new TestProcessScope(vanished.directory);
  owned.push(restored);
  assert.deepEqual(await restored.active(), []);
  await restored.stop();
  restored.remove();
  vanished.remove();
  const exitOnly = makeScope();
  fs.rmSync(exitOnly.directory, { recursive: true });
  disposeTestProcessResourcesSync();
  disposeTestProcessResourcesSync();
  console.log("✓ 已删除目录的恢复/重复清理/退出清理均幂等,不再产生 started ENOENT");

  const simulated = makeScope();
  const domain = { name: "simulated-domain", executable: "simulated-controller" };
  simulated.domain = domain;
  fs.writeFileSync(join(simulated.directory, "closed"), "stale closed marker");
  let exists = true;
  let processes = [{ pid: 123, born: "456" }];
  native.invoke = (_executable, [operation]) => {
    if (operation === "stop") { exists = false; processes = []; return ""; }
    assert.equal(operation, "state");
    return JSON.stringify({ exists, processes });
  };
  assert.deepEqual(await simulated.active(), processes);
  assert.throws(() => simulated.remove(), /尚有活动进程/);
  await simulated.stop();
  assert.deepEqual(await simulated.active(), []);
  simulated.remove();
  await simulated.stop();
  simulated.remove();

  const denied = makeScope();
  denied.domain = domain;
  const queryError = Object.assign(new Error("INJECTED_ACCESS_DENIED"), { code: "EACCES" });
  native.invoke = () => { throw queryError; };
  await assert.rejects(() => denied.active(), (error) => error === queryError);
  await assert.rejects(() => denied.stop(), /清理失败/);
  assert.throws(() => denied.remove(), (error) => error === queryError);
  assert.equal(fs.existsSync(denied.directory), true);
  native.invoke = () => JSON.stringify({ exists: false, processes: [{ pid: 123 }] });
  await assert.rejects(() => denied.active(), { code: "EOWNERSHIP" });
  native.invoke = () => JSON.stringify({ exists: false, processes: [] });
  denied.remove();
  native.invoke = original.invoke;
  console.log("✓ closed 文件不覆盖内核状态,域不存在与权限/查询失败分离,查询失败不删诊断域");

  if (process.platform !== "win32") {
    assert.throws(() => native.invoke("nonexistent-native.exe", ["state", "domain"]), { code: "EOWNERSHIP" });
    console.log(`⏭ ${process.platform}: Windows 内核生命周期未覆盖; 平台恢复入口显式 EOWNERSHIP`);
  } else {
    const external = makeScope();
    const child = external.spawn(process.execPath, ["-e", "process.exit()"], { stdio: "ignore" });
    await external.children[0].closed;
    assert.equal(child.exitCode, 0);
    const retired = childProcess.spawnSync(process.execPath, ["scripts/test-process-cleanup.mjs", external.directory], { encoding: "utf8", timeout: 30_000 });
    assert.ifError(retired.error);
    assert.equal(retired.status, 0, retired.stderr);
    assert.equal(fs.existsSync(external.directory), false);
    assert.deepEqual(await external.active(), []);
    await external.stop();
    external.remove();
    external.remove();
    console.log("✓ Windows 另一进程删除域和目录后,旧对象 active/stop/remove 重复调用无误报");

    const missingDirectory = makeScope();
    const ready = join(temporary, "running-ready");
    const late = join(temporary, "running-late");
    missingDirectory.spawn(process.execPath, ["-e", `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      setTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, 'late'), 1500);
      setInterval(() => {}, 1000);
    `], { stdio: "ignore" });
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(ready)) { assert.ok(Date.now() < deadline, "业务根未就绪"); await delay(10); }
    const retainedDomain = { ...missingDirectory.domain };
    fs.rmSync(missingDirectory.directory, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 });
    disposeTestProcessResourcesSync();
    await missingDirectory.children[0].closed;
    const executable = native.executable();
    assert.deepEqual(JSON.parse(native.invoke(executable, ["state", retainedDomain.name])), { exists: false, processes: [] });
    await delay(1600);
    assert.equal(fs.existsSync(late), false);
    console.log("✓ Windows 丢失目录的退出清理保留内核域身份,回收活动 Job 而非空目录即成功");

    for (const mode of ["spawn", "failed", "timeout"]) {
      const scope = makeScope();
      try {
        if (mode === "spawn") {
          childProcess.spawn = () => Object.assign(new EventEmitter(), { pid: undefined });
          syncBuiltinESMExports();
        } else if (mode === "failed") {
          native.invoke = (target, args) => args[0] === "identity" ? "0" : original.invoke(target, args);
        } else {
          let clockCalls = 0;
          const now = original.now();
          Date.now = () => ++clockCalls <= 2 ? now + (clockCalls - 1) * 21_000 : original.now();
          fs.existsSync = (target) => [join(scope.directory, "ready"), join(scope.directory, "failed")].includes(String(target)) ? false : original.existsSync(target);
          syncBuiltinESMExports();
        }
        assert.throws(() => scope.initialize(), mode === "failed" ? /Owner instance changed/ : { code: "EOWNERSHIP" });
      } finally {
        native.invoke = original.invoke;
        childProcess.spawn = original.spawn;
        fs.existsSync = original.existsSync;
        Date.now = original.now;
        syncBuiltinESMExports();
      }
      assert.equal(scope.domain, undefined);
      assert.equal(fs.existsSync(join(scope.directory, "domain.json")), false);
      if (scope.holder?.pid && scope.holder.exitCode === null && scope.holder.signalCode === null) {
        scope.holder.ref();
        await new Promise((resolveExited) => scope.holder.once("exit", resolveExited));
      }
      const restoredFailure = new TestProcessScope(scope.directory);
      owned.push(restoredFailure);
      await restoredFailure.stop();
      restoredFailure.remove();
      scope.remove();
      assert.equal(fs.existsSync(scope.directory), false);
    }
    console.log("✓ Windows spawn失败/真实身份握手失败/握手超时均回滚元数据,恢复与退出清理无永久失败域");

    const busy = Object.assign(new Error("INJECTED_EBUSY"), { code: "EBUSY" });
    const remove = fs.rmSync;
    let retryOptions;
    fs.rmSync = (target, options) => {
      if (String(target).includes("ash-test-process-")) { retryOptions = options; if (!options.maxRetries) throw busy; }
      return remove(target, options);
    };
    syncBuiltinESMExports();
    try { await runTestProcess(process.execPath, ["-e", "process.exit()"]); }
    finally { fs.rmSync = remove; syncBuiltinESMExports(); }
    assert.equal(retryOptions.maxRetries, 50);
    assert.equal(retryOptions.retryDelay, 20);
    console.log("✓ 捕获输出临时目录使用与执行域对称的有界删除重试");
  }
} finally {
  native.invoke = original.invoke;
  childProcess.spawn = original.spawn;
  fs.existsSync = original.existsSync;
  Date.now = original.now;
  syncBuiltinESMExports();
  for (const scope of owned) { await scope.stop(); scope.remove(); }
  disposeTestProcessResourcesSync();
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 });
}
