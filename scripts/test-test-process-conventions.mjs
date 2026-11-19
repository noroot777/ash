import assert from "node:assert/strict";
import { realAgentSwitchViolations, testCleanupViolations } from "./test-process-conventions.mjs";

for (const source of [
  "try { run(); } finally { await scope.stop(); scope.remove(); }",
  "try { run(); } finally { for (const scope of scopes) { await scope?.dispose(); } }",
  "try { run(); } finally { if (scope) scope['remove'](); }",
  "try { run(); } finally { { try { await scope.stop(); } finally { restore(); } } }",
]) assert.ok(testCleanupViolations(source, "fixture.mjs").length > 0, source);
for (const source of [
  "await withTestResources(run, [() => scope.stop(), () => scope.remove()]);",
  "try { run(); } finally { cleanupTestResourcesSync([() => scope.remove()], operationError); }",
  "try { run(); } finally { const text = 'scope.dispose()'; /* scope.stop(); */ restore(); }",
  "const service = { dispose() {} }; await service.dispose();",
]) assert.deepEqual(testCleanupViolations(source, "fixture.mjs"), [], source);
const nested = testCleanupViolations("try {} finally { try {} finally { scope.remove(); } }", "fixture.mjs");
assert.equal(nested.length, 1);
assert.match(nested[0], /^fixture\.mjs:1:\d+ /);
console.log("✓ AST 闸拦截 finally 裸析构及条件/循环/可选调用,资源回调/注释/字符串不误报且不重复计数");

for (const source of [
  'process.env.NAVI_ALLOW_REAL_AGENT = "1";',
  'process.env["NAVI_ALLOW_REAL_AGENT"] = previous;',
  "process.env.NAVI_ALLOW_REAL_AGENT ??= '1';",
  'spawn(node, args, { env: { ...process.env, NAVI_ALLOW_REAL_AGENT: "1" } });',
  'const NAVI_ALLOW_REAL_AGENT = "1"; spawn(node, args, { env: { NAVI_ALLOW_REAL_AGENT } });',
  'const env: Record<string, string> = { "NAVI_ALLOW_REAL_AGENT": "1" };',
  'spawn(node, args, { env: { ...process.env, ["NAVI_ALLOW_REAL_AGENT"]: "1" } });',
  'Reflect.set(process.env, "NAVI_ALLOW_REAL_AGENT", "1");',
  'Object.defineProperty(process.env, "NAVI_ALLOW_REAL_AGENT", { value: "1" });',
]) assert.equal(realAgentSwitchViolations(source, "fixture.ts").length, 1, source);
for (const source of [
  "delete process.env.NAVI_ALLOW_REAL_AGENT;",
  'assert.notEqual(process.env.NAVI_ALLOW_REAL_AGENT, "1");',
  'if (process.env.NAVI_ALLOW_REAL_AGENT !== "1") throw new Error("先设 NAVI_ALLOW_REAL_AGENT=1");',
  'const allowed = process.env.NAVI_ALLOW_REAL_AGENT === "1"; // process.env.NAVI_ALLOW_REAL_AGENT = "1"',
  "process.env.NAVI_TEST_AGENT_BIN = fakeBin;",
  'Reflect.get(process.env, "NAVI_ALLOW_REAL_AGENT");',
  'const key = "NAVI_ALLOW_REAL_AGENT"; const seen = key in process.env;',
]) assert.deepEqual(realAgentSwitchViolations(source, "fixture.ts"), [], source);
assert.match(realAgentSwitchViolations('\nprocess.env.NAVI_ALLOW_REAL_AGENT = "1";', "fixture.mjs")[0], /^fixture\.mjs:2:1 /);
console.log("✓ AST 闸拦截对整体放行开关的赋值、传给子进程的同名键(含写死的计算键)与点名的 Reflect.set/defineProperty,读/比较/delete/注释不误报");
