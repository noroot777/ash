import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readSource } from "../../scripts/read-source.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import type { AgentEvent } from "@ash/shared";
import { CodexExecutor } from "../src/executors/codex.js";
import { IS_WINDOWS } from "../src/platform.js";

const root = mkdtempSync(join(tmpdir(), "ash-codex-mcp-token-"));
const fakeCodexScript = join(root, "fake-codex.mjs");
const fakeCodex = IS_WINDOWS ? join(root, "fake-codex.cmd") : fakeCodexScript;
const probe = join(root, "mcp-probe.mjs");
const output = join(root, "mcp-env.json");
const oldProbe = process.env.ASH_FAKE_MCP_PROBE;
const oldOutput = process.env.ASH_FAKE_MCP_OUTPUT;
const oldStatus = process.env.ASH_FAKE_MCP_STATUS;
delete process.env.ASH_FAKE_MCP_TOOLS;
delete process.env.ASH_FAKE_EXEC_CALL;

try {
  assert.equal(ASH_MCP_SERVER_NAME, "ash", "安装器约定的规范 MCP 名必须是 ash");
  const setupSource = readSource(fileURLToPath(new URL("../../scripts/setup.mjs", import.meta.url)));
  assert.doesNotMatch(setupSource, /from\s+["'][^"']+\.ts["']/, "setup 必须兼容不能裸导入 TS 的 Node 22.16");
  assert.match(setupSource, /const ASH_MCP_SERVER_NAME = "ash"/, "安装器的规范名必须与运行时一致");
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
// 模拟 codex 的 -c 深合并:整张内联表(mcp_servers.<名>={…})与点号键(mcp_servers.<名>.env_vars=…)
// 按出现顺序合进同一条登记。最后那条登记既没有 command、配置文件里也没声明 ⇒ 真 codex 报
// invalid transport 拒载整份配置,这里用退出码 17 表示。
const servers = {};
for (let i = 0; i < args.length - 1; i += 1) {
  if (args[i] !== "-c") continue;
  const entry = args[i + 1];
  const table = /^mcp_servers\\.([^.=]+)=\\{(.*)\\}$/.exec(entry);
  const dotted = /^mcp_servers\\.([^.=]+)\\.env_vars=(.+)$/.exec(entry);
  if (table) {
    const vars = /env_vars=(\\[[^\\]]*\\])/.exec(table[2]);
    servers[table[1]] = { ...servers[table[1]], command: /(^|,)command=/.test(table[2]), ...(vars ? { envVars: JSON.parse(vars[1]) } : {}) };
  } else if (dotted) {
    servers[dotted[1]] = { ...servers[dotted[1]], envVars: JSON.parse(dotted[2]) };
  }
}
for (const [name, server] of Object.entries(servers)) {
  if (!server.command && !config.includes("[mcp_servers." + name + "]")) process.exit(17);
}
const configured = Object.fromEntries((servers.ash?.envVars ?? []).map((key) => [key, process.env[key]]));

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
    else if (message.method === "thread/archive") send({ id: message.id, result: {} });
    else if (message.method === "mcpServerStatus/list") {
      // ASH_FAKE_MCP_TOOLS = ash 这一回合真正暴露的工具(用户配置里的工具名单深合并保留下来之后)
      const tools = (process.env.ASH_FAKE_MCP_TOOLS ?? "complete_task,pause_task,ask_question,report_stage").split(",");
      send({ id: message.id, result: { data: [{ name: "ash", tools: Object.fromEntries(tools.map((t) => [t, {}])) }] } });
    }
    else if (message.method === "thread/start") {
      send({ id: message.id, result: { thread: { id: "fake-thread" } } });
      send({ method: "thread/started", params: { thread: { id: "fake-thread" } } });
      // ash 的 MCP 启动状态:ASH_FAKE_MCP_STATUS 不设 = codex 根本没加载 ash(一条都不报)。
      const status = process.env.ASH_FAKE_MCP_STATUS;
      const update = (s, error = null) => send({ method: "mcpServer/startupStatus/updated", params: {
        threadId: "fake-thread", name: "ash", status: s, error, failureReason: null,
      } });
      if (status) { update("starting"); update(status, status === "failed" ? "handshake closed" : null); }
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
  if (process.env.ASH_FAKE_EXEC_CALL) process.stdout.write(JSON.stringify({ type: "item.completed", item: {
    id: "item_1", type: "mcp_tool_call", server: "ash", tool: "complete_task", status: "completed",
  } }) + "\\n");
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
  // CODEX_HOME 里**没有任何 ash 登记**:ash 起跑时自己注入(executors/ash-mcp-inject.ts)。
  const unconfigured = join(root, "unconfigured");
  mkdirSync(unconfigured);
  const identity = { CODEX_HOME: unconfigured, ASH_TASK_ID: taskId, ASH_TURN_TOKEN: turnToken, ASH_DIRECTION_TOKEN: directionToken };
  const drain = async (events: AsyncIterable<AgentEvent>) => {
    const seen: AgentEvent[] = [];
    for await (const event of events) seen.push(event);
    return seen;
  };
  const ashProblems = (events: AgentEvent[]) =>
    events.filter((e): e is Extract<AgentEvent, { kind: "error" }> => e.kind === "error" && e.message.startsWith("ash 的工具在这一回合没接上"));

  process.env.ASH_FAKE_MCP_STATUS = "ready";
  const handle = executor.runSteerable({
    cwd: root,
    prompt: "probe",
    // 用户自己带了一条残缺白名单:注入排在它后面,同 key 以注入为准。
    extraArgs: ["-c", `mcp_servers.${ASH_MCP_SERVER_NAME}.env_vars=["ASH_TASK_ID"]`],
    env: identity,
  });
  const readyEvents = await drain(handle.events);
  await handle.cleanup?.();

  const childEnv = JSON.parse(readFileSync(output, "utf8")) as Record<string, string>;
  assert.equal(childEnv.ASH_TASK_ID, taskId, "Codex MCP 子进程应收到发起任务 id");
  assert.equal(childEnv.ASH_TURN_TOKEN, turnToken, "最终 env_vars 必须覆盖用户 extraArgs 的残缺白名单");
  assert.equal(childEnv.ASH_DIRECTION_TOKEN, directionToken, "Codex MCP 子进程应收到当前方向身份");
  assert.ok(!handle.commandLine.includes(turnToken), "sessions.commandLine 不得泄露回合 token");
  assert.ok(!handle.commandLine.includes(directionToken), "sessions.commandLine 不得泄露方向 token");
  assert.match(handle.commandLine, /mcp_servers\.ash=\{command=/, "整条 ash 登记由 ash 注入,不依赖 CODEX_HOME 里有没有");
  assert.ok(!handle.commandLine.includes("mcp_servers.harness"), "规范安装不能被历史 harness 名盖回去");
  assert.deepEqual(ashProblems(readyEvents), [], "codex 报 ready 时不出声");

  // exec 那条路(profile 带了 app-server 不认的参数时走它)注入同一份。
  delete process.env.ASH_FAKE_MCP_STATUS;
  rmSync(output, { force: true });
  const execHandle = executor.run({ cwd: root, prompt: "probe exec", env: identity });
  const execEvents = await drain(execHandle.events);
  await execHandle.cleanup?.();
  const execEnv = JSON.parse(readFileSync(output, "utf8")) as Record<string, string>;
  assert.equal(execEnv.ASH_TURN_TOKEN, turnToken, "exec 那条路同样透传回合身份");
  assert.match(execHandle.commandLine, /mcp_servers\.ash=\{command=/);
  assert.ok(!execHandle.commandLine.includes(turnToken), "exec 那条路同样不得泄露 token");
  // exec 这条路 codex 不报 MCP 启动状态:这一回合一次 ash 工具都没调成 ⇒ 一句「核实不了」(提示级)
  const execNotice = execEvents.filter((e): e is Extract<AgentEvent, { kind: "error" }> => e.kind === "error" && /codex exec/.test(e.message));
  assert.equal(execNotice.length, 1, `exec 回合没调成过 ash 的工具 ⇒ 一句核实不了:${JSON.stringify(execEvents.map((e) => e.kind))}`);
  assert.equal(execNotice[0]!.level, "notice");
  process.env.ASH_FAKE_EXEC_CALL = "1";
  const execCalled = executor.run({ cwd: root, prompt: "probe exec called", env: identity });
  const calledEvents = await drain(execCalled.events);
  await execCalled.cleanup?.();
  delete process.env.ASH_FAKE_EXEC_CALL;
  assert.ok(!calledEvents.some((e) => e.kind === "error" && /ash/.test(e.message)), "调成过 ash 的工具 ⇒ 不出声");
  const untracked = executor.run({ cwd: root, prompt: "probe exec chat", env: { CODEX_HOME: unconfigured } });
  const untrackedEvents = await drain(untracked.events);
  await untracked.cleanup?.();
  assert.ok(!untrackedEvents.some((e) => e.kind === "error" && /codex exec/.test(e.message)), "不是任务回合(没有回合身份)不说这句");

  // codex 报 ash 启动失败 ⇒ 当场一条诊断(带上 codex 的原话),不改本回合成败。
  process.env.ASH_FAKE_MCP_STATUS = "failed";
  const failedHandle = executor.runSteerable({ cwd: root, prompt: "probe failed", env: identity });
  const failed = ashProblems(await drain(failedHandle.events));
  await failedHandle.cleanup?.();
  assert.equal(failed.length, 1, "失败只说一次");
  assert.match(failed[0]!.message, /codex 报告 ash MCP 启动失败：handshake closed/);
  assert.equal(failed[0]!.affectsTurn, false, "这条是诊断,成败照旧由交卷判");

  // ready 了但用户配置里的工具名单把协议工具挡掉 ⇒ 经执行器问 mcpServerStatus/list 后出声。
  process.env.ASH_FAKE_MCP_STATUS = "ready";
  process.env.ASH_FAKE_MCP_TOOLS = "get_task,pause_task,ask_question,report_stage";
  const narrowedHandle = executor.runSteerable({ cwd: root, prompt: "probe narrowed", env: identity });
  const narrowed = ashProblems(await drain(narrowedHandle.events));
  await narrowedHandle.cleanup?.();
  delete process.env.ASH_FAKE_MCP_TOOLS;
  assert.equal(narrowed.length, 1, "工具清单缺了 complete_task ⇒ 一条诊断");
  assert.match(narrowed[0]!.message, /codex 连上了 ash，但 complete_task 不在 agent 手上/);

  // 一条状态都没报 ⇒ 回合收尾时说「没有加载」。
  delete process.env.ASH_FAKE_MCP_STATUS;
  const silentHandle = executor.runSteerable({ cwd: root, prompt: "probe silent", env: identity });
  const silent = ashProblems(await drain(silentHandle.events));
  await silentHandle.cleanup?.();
  assert.equal(silent.length, 1);
  assert.match(silent[0]!.message, /codex 这一回合没有加载 ash MCP/);
  console.log("✓ Codex 起跑注入 ash MCP(不依赖配置登记)、env_vars 透传回合身份、argv 无 token,ash 没连上 / 工具不全 / exec 核实不了时如实出声");
} finally {
  if (oldProbe === undefined) delete process.env.ASH_FAKE_MCP_PROBE;
  else process.env.ASH_FAKE_MCP_PROBE = oldProbe;
  if (oldOutput === undefined) delete process.env.ASH_FAKE_MCP_OUTPUT;
  else process.env.ASH_FAKE_MCP_OUTPUT = oldOutput;
  if (oldStatus === undefined) delete process.env.ASH_FAKE_MCP_STATUS;
  else process.env.ASH_FAKE_MCP_STATUS = oldStatus;
  rmSync(root, { recursive: true, force: true });
}
