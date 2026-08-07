// 真库测试不得启动真智能体。这道闸放在最底层 spawn 边界，所以普通管道、
// 输出落盘的 detached 管道、常驻会话都绕不过。
// Run: npm -w server run test:agent-spawn-guard
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harness-agent-guard-"));
process.env.HARNESS_RUNS_DIR = join(root, "runs");

const { spawnAgent } = await import("../src/executors/spawn.js");
const { detachedPathsFor, spawnDetachedAgent } = await import("../src/executors/detached.js");

function errorOf(child: ReturnType<typeof spawnAgent>): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("禁启错误没有送达")), 2000);
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      resolve(error.message);
    });
  });
}

try {
  const piped = spawnAgent({ kind: "local" }, root, process.execPath, ["-e", "process.exit(0)"], "");
  assert.match(await errorOf(piped), /测试隔离环境禁止启动真执行器/);

  const detached = spawnDetachedAgent(
    { kind: "local" },
    root,
    process.execPath,
    ["-e", "process.exit(0)"],
    "",
    detachedPathsFor(root, "session", "turn"),
  );
  assert.match(await errorOf(detached), /测试隔离环境禁止启动真执行器/);

  process.env.HARNESS_ALLOW_REAL_AGENT = "1";
  const allowed = spawnAgent({ kind: "local" }, root, process.execPath, ["-e", "process.exit(0)"], "");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    allowed.on("error", reject);
    allowed.on("close", resolve);
  });
  assert.equal(exitCode, 0, "显式放行的进程管理测试仍可启动假 CLI");
  console.log("agent spawn guard ok");
} finally {
  delete process.env.HARNESS_ALLOW_REAL_AGENT;
  rmSync(root, { recursive: true, force: true });
}
