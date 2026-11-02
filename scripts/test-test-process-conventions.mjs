import assert from "node:assert/strict";
import { testCleanupViolations } from "./test-process-conventions.mjs";

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
