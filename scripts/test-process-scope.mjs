import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import native from "./test-process-native.cjs";
import { cleanupTestResourcesSync, reportTestResourceError } from "./test-process-resources.mjs";
import { TestProcessScope as ObservableScope } from "./test-process-posix.mjs";
import { TestProcessScope as JobScope } from "./test-process-job.mjs";
import { scopes, cleanupFailures } from "./test-process-registry.mjs";

const cleanupPath = fileURLToPath(new URL("test-process-cleanup.mjs", import.meta.url));
export const TestProcessScope = process.platform === "win32" ? JobScope : ObservableScope;
export { delay, publishRecord, preservedPids, terminateInstance } from "./test-process-posix.mjs";

export function spawnTestFixture(commandName, args, options) {
  const scope = new TestProcessScope();
  try {
    const child = scope.spawn(commandName, args, options);
    child.dispose = async () => { await scope.stop(); scope.remove(); };
    return child;
  } catch (error) {
    if (!scope.domain && !scope.children.length) scope.remove();
    throw error;
  }
}

export function disposeTestScopesSync() {
  if (!scopes.size) return;
  const strikes = [];
  for (const scope of scopes) {
    if (cleanupFailures.has(scope.directory)) continue;
    try { scope.strikeBoundSync(); } catch (error) { strikes.push(error); }
  }
  const domains = new Map();
  for (const scope of scopes) if (!domains.has(scope.directory) || scope.domain) domains.set(scope.directory, {
    directory: scope.directory, domain: scope.domain, directoryOwnership: scope.directoryOwnership,
  });
  const pending = [...domains.values()]
    .filter(({ directory }) => !cleanupFailures.has(directory));
  let processError;
  if (pending.length) {
    const result = spawnSync(process.execPath, [cleanupPath], {
      input: JSON.stringify(pending),
      encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL", windowsHide: true,
      env: { ...process.env, ASH_TEST_PROCESS_SCOPE: "" },
    });
    if (result.error || result.signal || result.status !== 0) {
      processError = Object.assign(new Error(`测试执行域退出清理失败\n${result.stdout ?? ""}${result.stderr ?? ""}`, { cause: result.error }), {
        code: result.error?.code ?? "ETESTCLEANUP", result,
      });
    }
    const report = result.stdout?.split(/\r?\n/).find((line) => line.startsWith("ASH_TEST_SCOPE_CLEANUP="));
    let retired = new Set();
    try {
      const directories = JSON.parse(report?.slice("ASH_TEST_SCOPE_CLEANUP=".length));
      if (!Array.isArray(directories) || directories.some((directory) => typeof directory !== "string")) throw new Error("清理退役清单无效");
      retired = new Set(directories);
    } catch (error) { processError ??= new Error("测试执行域退出清理缺少有效退役清单", { cause: error }); }
    for (const { directory } of pending) {
      if (!retired.has(directory) || existsSync(directory)) cleanupFailures.set(directory, processError ?? new Error(`测试执行域未退役: ${directory}`));
      else for (const scope of scopes) if (scope.directory === directory) {
        scope.release?.();
        scope.domain = undefined;
        scope.sealed = true;
        scopes.delete(scope);
      }
    }
  }
  const errors = [...new Set([...strikes, processError, ...cleanupFailures.values()].filter(Boolean))];
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors,
    `测试执行域退出清理失败\n${errors.map((error) => error.message).join("\n")}`, { cause: errors[0] });
}

export function disposeTestProcessResourcesSync() {
  cleanupTestResourcesSync([disposeTestScopesSync, () => { if (!scopes.size) native.dispose(); }]);
}

process.once("exit", () => {
  if (process.argv[1] && resolve(process.argv[1]) === cleanupPath) return;
  try { disposeTestProcessResourcesSync(); } catch (error) { reportTestResourceError(error); process.exitCode = 1; }
});
