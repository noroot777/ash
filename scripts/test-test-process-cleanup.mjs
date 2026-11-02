import { TestProcessScope as JobScope } from "./test-process-job.mjs";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestProcessScope, disposeTestProcessResourcesSync, disposeTestScopesSync } from "./test-process-scope.mjs";
import { cleanupTestResources, cleanupTestResourcesSync, reportTestResourceError, withTestResources } from "./test-process-resources.mjs";
import native from "./test-process-native.cjs";

const temporary = fs.mkdtempSync(join(tmpdir(), "ash-test-cleanup-"));
const original = { spawnSync: childProcess.spawnSync, dispose: native.dispose, executable: native.executable, invoke: native.invoke, error: console.error };
const owned = [];
await withTestResources(async () => {
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
  childProcess.spawnSync = (_command, _args, options) => {
    cleanups++;
    const directories = JSON.parse(options.input).map((scope) => scope.directory);
    if (cleanups === 1) {
      assert.deepEqual(directories, [failed.directory]);
      return { status: 1, signal: null, stdout: "", stderr: "ORIGINAL_CLEANUP_FAILURE" };
    }
    assert.ok(!directories.includes(failed.directory));
    for (const directory of directories) fs.rmSync(directory, { recursive: true });
    return { status: 0, signal: null, stdout: `ASH_TEST_SCOPE_CLEANUP=${JSON.stringify(directories)}\n`, stderr: "" };
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

  const blocked = new TestProcessScope();
  const retired = new TestProcessScope();
  owned.push(blocked, retired);
  retired.domain = { name: "retired-job", executable: "retired-controller" };
  native.invoke = (target, args) => args[1] === "retired-job"
    ? args[0] === "state" ? JSON.stringify({ exists: false, processes: [] }) : ""
    : original.invoke(target, args);
  fs.rmSync(retired.directory, { recursive: true });
  let mixedAttempts = 0;
  childProcess.spawnSync = (_command, _args, options) => {
    mixedAttempts++;
    const pending = JSON.parse(options.input);
    assert.equal(pending.find((scope) => scope.directory === retired.directory).domain.name, "retired-job");
    return { status: 1, signal: null, stdout: `ASH_TEST_SCOPE_CLEANUP=${JSON.stringify([retired.directory])}\n`, stderr: "ONE_DOMAIN_FAILED" };
  };
  syncBuiltinESMExports();
  assert.throws(() => disposeTestScopesSync(), /ONE_DOMAIN_FAILED/);
  assert.equal(retired.domain, undefined);
  assert.throws(() => disposeTestScopesSync(), /ONE_DOMAIN_FAILED/);
  assert.equal(mixedAttempts, 1);
  blocked.remove();
  console.log("✓ 多域清理按权威退役清单独立结算,其他域失败不把已退役且目录已删的域永久判失败");

  const initialization = new JobScope();
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
}, [
  () => {
    childProcess.spawnSync = original.spawnSync;
    native.dispose = original.dispose;
    native.executable = original.executable;
    console.error = original.error;
    native.invoke = (target, args) => args[1] === "retired-job" ? JSON.stringify({ exists: false, processes: [] }) : original.invoke(target, args);
    syncBuiltinESMExports();
  },
  () => cleanupTestResources(owned.flatMap((scope) => [() => scope.stop(), () => scope.remove()])),
  () => { native.invoke = original.invoke; },
  () => fs.rmSync(temporary, { recursive: true, force: true }),
]);
