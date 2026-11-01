import assert from "node:assert/strict";
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestProcessScope, delay, preservedPids } from "./test-process-scope.mjs";

export function assertProcessResult(result, expectedStatus = 0, label = "子进程") {
  const details = `${label}: status=${result.status}, signal=${result.signal}, error=${result.error?.code ?? "none"}\n${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) {
    throw Object.assign(new Error(details, { cause: result.error }), {
      code: result.error.code, stdout: result.stdout, stderr: result.stderr,
    });
  }
  assert.equal(result.signal, null, details);
  assert.equal(result.status, expectedStatus, details);
  assert.equal(typeof result.stdout, "string", `${label}: stdout 未完整收集`);
  assert.equal(typeof result.stderr, "string", `${label}: stderr 未完整收集`);
  return result;
}

export async function runTestProcess(command, args, options = {}, expectedStatus = 0) {
  let temporary;
  const descriptors = [];
  let scope;
  const { timeout = 120_000, preserveScripts = [], ...spawnOptions } = options;
  let completed = false;
  let expired = false;
  let timer;
  let result;
  let operationError;
  const captured = { stdout: "", stderr: "" };
  const cleanupErrors = [];
  let stdoutPath;
  let stderrPath;
  try {
    temporary = mkdtempSync(join(tmpdir(), "ash-test-process-"));
    scope = new TestProcessScope();
    stdoutPath = join(temporary, "stdout.log");
    stderrPath = join(temporary, "stderr.log");
    const stdout = openSync(stdoutPath, "w");
    descriptors.push(stdout);
    const stderr = openSync(stderrPath, "w");
    descriptors.push(stderr);
    const capturedStreams = descriptors.map((descriptor) => { const stat = fstatSync(descriptor); return `${stat.dev}:${stat.ino}`; });
    const child = scope.spawn(command, args, {
      ...spawnOptions,
      stdio: ["ignore", stdout, stderr],
    });
    const finished = new Promise((resolveResult) => {
      child.once("error", (error) => resolveResult({ status: null, signal: null, error }));
      child.once("exit", (status, signal) => resolveResult({ status, signal }));
    });
    const deadline = timeout > 0 ? Date.now() + timeout : Infinity;
    const expiration = new Promise((resolveTimeout) => {
      if (timeout > 0) timer = setTimeout(() => { expired = true; resolveTimeout(null); }, timeout);
    });
    result = await Promise.race([finished, expiration]);
    scope.sealed = true;
    if (result && !result.error && !result.signal && result.status === expectedStatus) {
      while (true) {
        const active = await scope.active();
        const spared = preservedPids(scope, preserveScripts, capturedStreams, active);
        if (!active.some((row) => !spared.has(row.pid))) break;
        if (expired || Date.now() >= deadline) { expired = true; break; }
        await delay(30);
      }
    }
    clearTimeout(timer);
    if (!result || expired) result = { ...result, error: Object.assign(new Error("测试执行超时"), { code: "ETIMEDOUT" }) };
    if (result.error || result.signal || result.status !== expectedStatus) {
      await scope.stop();
      await finished;
    }
    const remaining = await scope.active();
    if (!remaining.length) scope.remove();
    completed = true;
  } catch (error) { operationError = error; }
  finally {
    clearTimeout(timer);
    const cleanupScope = async () => {
      if (!scope || !existsSync(scope.directory)) return;
      try { await scope.stop(); scope.remove(); }
      catch (error) { cleanupErrors.push(error); }
    };
    if (!completed) await cleanupScope();
    for (const [stream, path] of [["stdout", stdoutPath], ["stderr", stderrPath]]) {
      if (!path) continue;
      try { captured[stream] = readFileSync(path, "utf8"); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (completed && cleanupErrors.length) await cleanupScope();
    for (const descriptor of descriptors) {
      try { closeSync(descriptor); }
      catch (error) { cleanupErrors.push(error); }
    }
    try { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (expired) result = { ...result, error: Object.assign(new Error("测试执行超时"), { code: "ETIMEDOUT" }) };
  if (!result) result = { status: null, signal: null, error: operationError };
  let failure;
  try { assertProcessResult({ ...result, ...captured }, expectedStatus, command); }
  catch (error) { failure = error; }
  const errors = [failure, operationError, ...cleanupErrors].filter(Boolean);
  if (errors.length) {
    if (errors.length === 1 && failure) throw failure;
    const cause = failure ?? operationError ?? cleanupErrors[0];
    throw Object.assign(new AggregateError(errors,
      `${command}: 测试执行或清理失败\n${errors.map((error) => error.message).join("\n")}\n${captured.stdout}${captured.stderr}`, { cause }), {
      code: cause.code, ...captured, cleanupErrors,
    });
  }
  return { ...result, ...captured, dispose: async () => {
    if (scope && existsSync(scope.directory)) { await scope.stop(); scope.remove(); }
  } };
}
