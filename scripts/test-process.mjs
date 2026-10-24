import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function assertProcessResult(result, expectedStatus = 0, label = "子进程") {
  const details = `${label}: status=${result.status}, signal=${result.signal}, error=${result.error?.code ?? "none"}\n${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.ifError(result.error);
  assert.equal(result.signal, null, details);
  assert.equal(result.status, expectedStatus, details);
  assert.equal(typeof result.stdout, "string", `${label}: stdout 未完整收集`);
  assert.equal(typeof result.stderr, "string", `${label}: stderr 未完整收集`);
  return result;
}

export function runTestProcess(command, args, options = {}, expectedStatus = 0) {
  const temporary = mkdtempSync(join(tmpdir(), "ash-test-process-"));
  const descriptors = [];
  try {
    const stdoutPath = join(temporary, "stdout.log");
    const stderrPath = join(temporary, "stderr.log");
    const stdout = openSync(stdoutPath, "w");
    descriptors.push(stdout);
    const stderr = openSync(stderrPath, "w");
    descriptors.push(stderr);
    const result = spawnSync(command, args, {
      timeout: 120_000, windowsHide: true, ...options,
      stdio: ["ignore", stdout, stderr],
    });
    return assertProcessResult({
      ...result,
      stdout: readFileSync(stdoutPath, "utf8"),
      stderr: readFileSync(stderrPath, "utf8"),
    }, expectedStatus, command);
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
    rmSync(temporary, { recursive: true, force: true });
  }
}
