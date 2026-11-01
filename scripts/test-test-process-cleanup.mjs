import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestProcessScope, disposeTestProcessResourcesSync, disposeTestScopesSync } from "./test-process-scope.mjs";
import { cleanupTestResourcesSync, reportTestResourceError } from "./test-process-resources.mjs";
import native from "./test-process-native.cjs";

const temporary = fs.mkdtempSync(join(tmpdir(), "ash-test-cleanup-"));
const original = { spawnSync: childProcess.spawnSync, dispose: native.dispose, executable: native.executable, error: console.error };
const owned = [];
try {
  const fixture = join(temporary, "business-fixture");
  fs.mkdirSync(fixture);
  const businessError = Object.assign(new Error("BUSINESS_ASSERTION"), { code: "EBUSINESS", stdout: "BUSINESS_OUT", stderr: "BUSINESS_ERR" });
  const cleanupError = new Error("CLEANUP_FAILURE");
  assert.throws(() => cleanupTestResourcesSync([
    () => { throw cleanupError; },
    () => fs.rmSync(fixture, { recursive: true }),
  ], businessError), (error) => {
    assert.equal(error.cause, businessError);
    assert.equal(error.code, "EBUSINESS");
    assert.equal(error.stdout, "BUSINESS_OUT");
    assert.equal(error.stderr, "BUSINESS_ERR");
    assert.deepEqual(error.errors, [businessError, cleanupError]);
    assert.deepEqual(error.cleanupErrors, [cleanupError]);
    assert.match(error.message, /BUSINESS_ASSERTION/);
    assert.match(error.message, /CLEANUP_FAILURE/);
    return true;
  });
  assert.equal(fs.existsSync(fixture), false);
  assert.throws(() => cleanupTestResourcesSync([() => {}], businessError), (error) => error === businessError);
  let reports = 0;
  console.error = () => { reports++; };
  reportTestResourceError(cleanupError);
  reportTestResourceError(new AggregateError([cleanupError], "重复退出报告"));
  console.error = original.error;
  assert.equal(reports, 1);
  console.log("✓ 原始断言/双流不被清理错误覆盖,其他资源仍回收,重复退出不重复报告同一错误");

  const artifact = join(temporary, "native-controller.exe");
  fs.writeFileSync(artifact, "retained diagnostic artifact");
  const failed = new TestProcessScope();
  owned.push(failed);
  let cleanups = 0;
  let disposals = 0;
  native.dispose = () => { disposals++; fs.rmSync(artifact, { force: true }); };
  childProcess.spawnSync = (_command, args) => {
    cleanups++;
    if (cleanups === 1) {
      assert.deepEqual(args.slice(1), [failed.directory]);
      return { status: 1, signal: null, stdout: "", stderr: "ORIGINAL_CLEANUP_FAILURE" };
    }
    assert.ok(!args.includes(failed.directory));
    for (const directory of args.slice(1)) fs.rmSync(directory, { recursive: true });
    return { status: 0, signal: null, stdout: "", stderr: "" };
  };
  syncBuiltinESMExports();
  let originalFailure;
  assert.throws(() => disposeTestProcessResourcesSync(), (error) => {
    originalFailure = error;
    assert.match(error.message, /ORIGINAL_CLEANUP_FAILURE/);
    return true;
  });
  assert.equal(disposals, 0);
  assert.equal(fs.existsSync(artifact), true);
  assert.throws(() => disposeTestProcessResourcesSync(), (error) => error === originalFailure);
  assert.equal(cleanups, 1);
  const later = new TestProcessScope();
  owned.push(later);
  assert.throws(() => disposeTestScopesSync(), (error) => error === originalFailure);
  assert.equal(cleanups, 2);
  assert.equal(fs.existsSync(later.directory), false);
  assert.equal(fs.existsSync(failed.directory), true);
  assert.equal(disposals, 0);
  failed.remove();
  disposeTestProcessResourcesSync();
  assert.equal(disposals, 1);
  assert.equal(fs.existsSync(artifact), false);
  console.log("✓ 失败执行域不隐式重试/不删除原生工具,新执行域仍清理,全部退役后才回收编译产物");

  const initialization = new TestProcessScope();
  owned.push(initialization);
  const unavailable = Object.assign(new Error("ORIGINAL_EOWNERSHIP"), { code: "EOWNERSHIP" });
  let attempts = 0;
  native.executable = () => { attempts++; throw unavailable; };
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(() => initialization.spawn(process.execPath, ["-e", "process.exit()"]), (error) => error === unavailable);
  }
  assert.equal(attempts, 1);
  initialization.remove();
  console.log("✓ 同一执行域初始化失败后保持原始诊断,重复启动不被 EEXIST 等次生错误替换");
} finally {
  childProcess.spawnSync = original.spawnSync;
  native.dispose = original.dispose;
  native.executable = original.executable;
  console.error = original.error;
  syncBuiltinESMExports();
  for (const scope of owned) if (fs.existsSync(scope.directory)) scope.remove();
  fs.rmSync(temporary, { recursive: true, force: true });
}
