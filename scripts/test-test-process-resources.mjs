import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { cleanupTestResources, withTestResources } from "./test-process-resources.mjs";

const business = Object.assign(new Error("INJECTED_BUSINESS_ASSERTION"), { code: "EBUSINESS", stdout: "BUSINESS_OUT", stderr: "BUSINESS_ERR" });
const stopError = new Error("INJECTED_STOP_FAILURE");
const removeError = new Error("INJECTED_REMOVE_FAILURE");
const visited = [];
await assert.rejects(() => withTestResources(async () => { throw business; }, [
  async () => { visited.push("stop"); throw stopError; },
  () => { visited.push("remove"); throw removeError; },
  async () => { visited.push("later"); },
]), (error) => {
  assert.equal(error.cause, business);
  assert.equal(error.code, "EBUSINESS");
  assert.equal(error.stdout, "BUSINESS_OUT");
  assert.equal(error.stderr, "BUSINESS_ERR");
  assert.deepEqual(error.errors, [business, stopError, removeError]);
  assert.deepEqual(error.cleanupErrors, [stopError, removeError]);
  for (const failure of error.errors) assert.ok(error.message.includes(failure.message));
  return true;
});
assert.deepEqual(visited, ["stop", "remove", "later"]);
await assert.rejects(() => withTestResources(() => { throw business; }, [async () => {}]), (error) => error === business);
assert.equal(await withTestResources(async () => "result", [async () => {}]), "result");
await assert.rejects(() => cleanupTestResources([async () => { throw stopError; }]), (error) => error === stopError);
console.log("✓ 异步资源层保留原断言/双流/原因,多个回收失败独立聚合且后续资源仍执行");

const lifecycleURL = new URL("test-test-process-lifecycle.mjs", import.meta.url);
const assertion = "assert.deepEqual(await simulated.active(), processes.map((row) => ({ ...row, created: row.born })));";
const source = readFileSync(lifecycleURL, "utf8");
assert.equal(source.split(assertion).length, 2);
const injected = source.replace(assertion, "assert.deepEqual(await simulated.active(), [{ pid: 999, born: '999' }], 'INJECTED_BUSINESS_ASSERTION');")
  .replace(/from "(\.\/[^\"]+)"/g, (_match, specifier) => `from ${JSON.stringify(new URL(specifier, lifecycleURL).href)}`);
const child = spawnSync(process.execPath, ["-e", `
  const fs = require('node:fs'); const original = fs.mkdtempSync; const created = [];
  fs.mkdtempSync = (...args) => { const directory = original(...args); created.push(directory); return directory; };
  require('node:module').syncBuiltinESMExports();
  import(${JSON.stringify("data:text/javascript;base64," + Buffer.from(injected).toString("base64"))})
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => console.log('RESOURCE_DIRECTORIES=' + JSON.stringify(created)));
`], { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
let directories = [];
await withTestResources(() => {
  assert.ifError(child.error);
  const manifest = child.stdout.split(/\r?\n/).find((line) => line.startsWith("RESOURCE_DIRECTORIES="));
  assert.ok(manifest, child.stderr);
  directories = JSON.parse(manifest.slice("RESOURCE_DIRECTORIES=".length));
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /INJECTED_BUSINESS_ASSERTION/);
  assert.ok(directories.some((directory) => directory.includes("ash-test-lifecycle-")));
  assert.ok(directories.some((directory) => directory.includes("ash-test-scope-")));
  assert.deepEqual(directories.filter((directory) => existsSync(directory)), []);
}, [() => cleanupTestResources(directories.map((directory) => () => rmSync(directory, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 })))]);
console.log("✓ 真实生命周期脚本注入业务断言后原错仍可见,模拟域/临时目录全部回收");
