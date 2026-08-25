import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexExecutor } from "../src/executors/codex.js";

const root = mkdtempSync(join(tmpdir(), "ash-codex-mcp-token-"));
const fakeCodex = join(root, "fake-codex.mjs");
const probe = join(root, "mcp-probe.mjs");
const output = join(root, "mcp-env.json");
const oldProbe = process.env.ASH_FAKE_MCP_PROBE;
const oldOutput = process.env.ASH_FAKE_MCP_OUTPUT;

try {
  writeFileSync(probe, `
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], JSON.stringify(process.env));
`);
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const configured = {};
for (let i = 0; i < args.length - 1; i += 1) {
  if (args[i] !== "-c") continue;
  const entry = args[i + 1];
  const prefix = "mcp_servers.harness.env.";
  if (!entry.startsWith(prefix)) continue;
  const split = entry.indexOf("=");
  const key = entry.slice(prefix.length, split);
  configured[key] = JSON.parse(entry.slice(split + 1));
}

// 模拟 codex 0.144 的 MCP 环境白名单：父进程里的 ASH_* 全丢，只把 -c 中显式配置的
// harness.env 加回来，再真正跨一层子进程启动 MCP probe。
const filtered = {};
for (const key of ["HOME", "LANG", "PATH", "SHELL", "TMPDIR", "USER"]) {
  if (process.env[key]) filtered[key] = process.env[key];
}
const child = spawnSync(process.execPath, [process.env.ASH_FAKE_MCP_PROBE, process.env.ASH_FAKE_MCP_OUTPUT], {
  env: { ...filtered, ...configured },
});
if (child.status !== 0) process.exit(child.status ?? 2);
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
`);
  chmodSync(fakeCodex, 0o755);
  process.env.ASH_FAKE_MCP_PROBE = probe;
  process.env.ASH_FAKE_MCP_OUTPUT = output;

  const turnToken = "turn-token-secret-123456";
  const taskId = "task-codex-boundary";
  const executor = new CodexExecutor({ bin: fakeCodex });
  const handle = executor.run({
    cwd: root,
    prompt: "probe",
    extraArgs: ["-c", 'mcp_servers.harness.env.ASH_TURN_TOKEN="stale-user-override"'],
    env: { ASH_TASK_ID: taskId, ASH_TURN_TOKEN: turnToken },
  });
  for await (const _event of handle.events) {
    // 消费到进程退出，确保 probe 已写完。
  }

  const childEnv = JSON.parse(readFileSync(output, "utf8")) as Record<string, string>;
  assert.equal(childEnv.ASH_TASK_ID, taskId, "Codex MCP 子进程应收到发起任务 id");
  assert.equal(childEnv.ASH_TURN_TOKEN, turnToken, "最终注入必须覆盖用户 extraArgs 里的旧 token");
  assert.ok(!handle.commandLine.includes(turnToken), "sessions.commandLine 不得泄露回合 token");
  assert.match(handle.commandLine, /ASH_TURN_TOKEN="\*\*\*"/, "展示命令应明确遮盖 token");
  console.log("✓ Codex 过滤环境后，harness MCP 仍收到当前任务与回合 token，展示命令已打码");
} finally {
  if (oldProbe === undefined) delete process.env.ASH_FAKE_MCP_PROBE;
  else process.env.ASH_FAKE_MCP_PROBE = oldProbe;
  if (oldOutput === undefined) delete process.env.ASH_FAKE_MCP_OUTPUT;
  else process.env.ASH_FAKE_MCP_OUTPUT = oldOutput;
  rmSync(root, { recursive: true, force: true });
}
