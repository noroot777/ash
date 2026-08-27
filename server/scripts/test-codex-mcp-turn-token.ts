import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { CodexExecutor } from "../src/executors/codex.js";
import { codexAshMcpServerName } from "../src/executors/codex-mcp.js";
import { IS_WINDOWS } from "../src/platform.js";

const root = mkdtempSync(join(tmpdir(), "ash-codex-mcp-token-"));
const fakeCodexScript = join(root, "fake-codex.mjs");
const fakeCodex = IS_WINDOWS ? join(root, "fake-codex.cmd") : fakeCodexScript;
const probe = join(root, "mcp-probe.mjs");
const output = join(root, "mcp-env.json");
const oldProbe = process.env.ASH_FAKE_MCP_PROBE;
const oldOutput = process.env.ASH_FAKE_MCP_OUTPUT;

try {
  assert.equal(ASH_MCP_SERVER_NAME, "ash", "安装器约定的规范 MCP 名必须是 ash");
  const setupSource = readFileSync(fileURLToPath(new URL("../../scripts/setup.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(setupSource, /from\s+["'][^"']+\.ts["']/, "setup 必须兼容不能裸导入 TS 的 Node 22.16");
  assert.match(setupSource, /const ASH_MCP_SERVER_NAME = "ash"/, "安装器的规范名必须与运行时一致");
  writeFileSync(join(root, "config.toml"), `
[mcp_servers.${ASH_MCP_SERVER_NAME}]
command = "node"
`);
  writeFileSync(probe, `
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], JSON.stringify(process.env));
`);
  writeFileSync(fakeCodexScript, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
let config = "";
try { config = readFileSync(join(process.env.CODEX_HOME, "config.toml"), "utf8"); } catch {}
let configured = {};
for (let i = 0; i < args.length - 1; i += 1) {
  if (args[i] !== "-c") continue;
  const entry = args[i + 1];
  const matched = /^mcp_servers\\.([^.]+)\\.env_vars=(.+)$/.exec(entry);
  if (!matched) continue;
  if (!config.includes("[mcp_servers." + matched[1] + "]")) process.exit(17);
  configured = Object.fromEntries(JSON.parse(matched[2]).map((key) => [key, process.env[key]]));
}

// 模拟 codex 0.144 的 MCP 环境白名单：父进程里的 ASH_* 全丢，只把 -c 中显式配置的
// env_vars 按变量名选中的值加回来，再真正跨一层子进程启动 MCP probe。
const runProbe = () => {
  const filtered = {};
  for (const key of ["HOME", "LANG", "PATH", "SHELL", "TMPDIR", "USER"]) {
    if (process.env[key]) filtered[key] = process.env[key];
  }
  const child = spawnSync(process.execPath, [process.env.ASH_FAKE_MCP_PROBE, process.env.ASH_FAKE_MCP_OUTPUT], {
    env: { ...filtered, ...configured },
  });
  if (child.status !== 0) process.exit(child.status ?? 2);
};

if (args.includes("app-server")) {
  let input = "";
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
  const receive = (message) => {
    if (message.id === undefined) return;
    if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake" } });
    else if (message.method === "thread/start") {
      send({ id: message.id, result: { thread: { id: "fake-thread" } } });
      send({ method: "thread/started", params: { thread: { id: "fake-thread" } } });
    } else if (message.method === "turn/start") {
      runProbe();
      send({ id: message.id, result: { turn: { id: "fake-turn" } } });
      send({ method: "turn/started", params: { threadId: "fake-thread", turn: { id: "fake-turn" } } });
      setTimeout(() => send({ method: "turn/completed", params: {
        threadId: "fake-thread", turn: { id: "fake-turn", status: "completed", error: null },
      } }), 10);
    }
  };
  process.stdin.on("data", (chunk) => {
    input += chunk.toString();
    for (;;) {
      const newline = input.indexOf("\\n");
      if (newline < 0) break;
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (line) receive(JSON.parse(line));
    }
  });
  process.stdin.on("end", () => process.exit(0));
} else {
  runProbe();
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
}
`);
  if (IS_WINDOWS) writeFileSync(fakeCodex, `@node "%~dp0fake-codex.mjs" %*\r\n`);
  else chmodSync(fakeCodex, 0o755);
  process.env.ASH_FAKE_MCP_PROBE = probe;
  process.env.ASH_FAKE_MCP_OUTPUT = output;

  const turnToken = "turn-token-secret-123456";
  const directionToken = "direction-token-secret-123456";
  const taskId = "task-codex-boundary";
  const executor = new CodexExecutor({ bin: fakeCodex });
  const handle = executor.runSteerable({
    cwd: root,
    prompt: "probe",
    extraArgs: ["-c", `mcp_servers.${ASH_MCP_SERVER_NAME}.env_vars=["ASH_TASK_ID"]`],
    env: { CODEX_HOME: root, ASH_TASK_ID: taskId, ASH_TURN_TOKEN: turnToken, ASH_DIRECTION_TOKEN: directionToken },
  });
  for await (const _event of handle.events) {
    // 消费到进程退出，确保 probe 已写完。
  }
  await handle.cleanup?.();

  const childEnv = JSON.parse(readFileSync(output, "utf8")) as Record<string, string>;
  assert.equal(childEnv.ASH_TASK_ID, taskId, "Codex MCP 子进程应收到发起任务 id");
  assert.equal(childEnv.ASH_TURN_TOKEN, turnToken, "最终 env_vars 必须覆盖用户 extraArgs 的残缺白名单");
  assert.equal(childEnv.ASH_DIRECTION_TOKEN, directionToken, "Codex MCP 子进程应收到当前方向身份");
  assert.ok(!handle.commandLine.includes(turnToken), "sessions.commandLine 不得泄露回合 token");
  assert.ok(!handle.commandLine.includes(directionToken), "sessions.commandLine 不得泄露方向 token");
  assert.match(handle.commandLine, /mcp_servers\.ash\.env_vars=/, "参数必须写到规范 ash MCP 条目");
  assert.ok(!handle.commandLine.includes("mcp_servers.harness"), "规范安装不能被历史 harness 名盖回去");

  const unconfigured = join(root, "unconfigured");
  mkdirSync(unconfigured);
  assert.equal(codexAshMcpServerName(unconfigured), null, "没有声明 MCP server 时不得凭空补一个 ash 条目");
  const noMcpHandle = executor.runSteerable({
    cwd: root,
    prompt: "probe without registered MCP",
    env: { CODEX_HOME: unconfigured, ASH_TASK_ID: taskId, ASH_TURN_TOKEN: turnToken, ASH_DIRECTION_TOKEN: directionToken },
  });
  for await (const _event of noMcpHandle.events) {
    // 等假 Codex 完整退出。
  }
  await noMcpHandle.cleanup?.();
  assert.ok(!noMcpHandle.commandLine.includes("mcp_servers."), "未配置 MCP 时 Codex argv 不得出现无效 server 覆盖");
  assert.ok(!noMcpHandle.commandLine.includes(turnToken), "未配置 MCP 的降级路径同样不得泄露 token");
  const noMcpChildEnv = JSON.parse(readFileSync(output, "utf8")) as Record<string, string>;
  assert.equal(noMcpChildEnv.ASH_TASK_ID, undefined);
  assert.equal(noMcpChildEnv.ASH_TURN_TOKEN, undefined, "未注册 MCP 时只能降级，不能伪造一个无效 transport");
  assert.equal(noMcpChildEnv.ASH_DIRECTION_TOKEN, undefined);

  writeFileSync(join(root, "config.toml"), `
[mcp_servers.${LEGACY_ASH_MCP_SERVER_NAME}]
command = "node"
`);
  assert.equal(codexAshMcpServerName(root), LEGACY_ASH_MCP_SERVER_NAME, "迁移前的旧配置仍应可运行");
  console.log("✓ Codex 用规范 ash/env_vars 透传回合身份，argv 无 token，并兼容旧 harness 配置");
} finally {
  if (oldProbe === undefined) delete process.env.ASH_FAKE_MCP_PROBE;
  else process.env.ASH_FAKE_MCP_PROBE = oldProbe;
  if (oldOutput === undefined) delete process.env.ASH_FAKE_MCP_OUTPUT;
  else process.env.ASH_FAKE_MCP_OUTPUT = oldOutput;
  rmSync(root, { recursive: true, force: true });
}
