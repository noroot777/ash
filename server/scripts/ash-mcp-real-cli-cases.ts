// test-ash-mcp-inject.ts 里要真 CLI 的那两段:没装对应 CLI 就跳过(打一行 ⚠)。
//
// MCP 服务都是这里自带的最小桩(只答 initialize / tools/list),不依赖 mcp/dist 有没有 build;
// 两家都只走到「启动报告」那一步就收手,不调模型、不花额度,也不碰用户的 CLI 配置(各用临时目录)。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentEvent } from "@ash/shared";
import { ASH_MCP_TOOLS } from "@ash/shared/mcp";
import { CodexAshMcpStatus } from "../src/executors/ash-mcp-confirm.js";
import { codexAshMcpArgs } from "../src/executors/ash-mcp-inject.js";
import { resolveLaunch } from "../src/executors/bin-resolve.js";

/** 一个最小 MCP 桩。`<标记> [--die <ms>] [工具…]`:拉起时把标记追加进 `started`;`--die` = 握手不答、过一会儿退出。 */
function writeStub(root: string): { stub: string; started: string } {
  const stub = join(root, "mcp-stub.mjs");
  const started = join(root, "mcp-started.txt");
  writeFileSync(stub, `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [tag, ...rest] = process.argv.slice(2);
appendFileSync(${JSON.stringify(started)}, tag + "\\n");
if (rest[0] === "--die") setTimeout(() => process.exit(1), Number(rest[1]));
else createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  const reply = (body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...body }) + "\\n");
  if (m.method === "initialize") reply({ result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: tag, version: "1" } } });
  else if (m.method === "tools/list") reply({ result: { tools: rest.map((name) => ({ name, description: name, inputSchema: { type: "object" } })) } });
  else reply({ error: { code: -32601, message: "nope" } });
});
`);
  return { stub, started };
}

const startedTags = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : []);

/**
 * 真 claude:同名 server 以**最后一个** `--mcp-config` 为准 —— 注入排在最后靠的就是这条。
 * 用户配置里的同名 ash、profile 里更早的 `--mcp-config`、`--strict-mcp-config` 都压不过它。
 */
export async function checkRealClaudePrecedence(root: string): Promise<void> {
  const launch = resolveLaunch("claude", ["--version"]);
  if (!launch) { console.log("⚠ 没装 claude,跳过真 claude 的同名优先级那一段"); return; }
  for (const variant of [[], ["--strict-mcp-config"]]) {
    const dir = mkdtempSync(join(root, "claude-order-"));
    const { stub, started } = writeStub(dir);
    const home = join(dir, "home");
    mkdirSync(home);
    const server = (tag: string) => ({ type: "stdio", command: process.execPath, args: [stub, tag, "complete_task"] });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { ash: server("user-scope") } }));
    const config = (tag: string) => {
      const file = join(dir, `${tag}.json`);
      writeFileSync(file, JSON.stringify({ mcpServers: { ash: server(tag) } }));
      return file;
    };
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--max-turns", "1",
      ...variant, "--mcp-config", config("profile"), "--mcp-config", config("injected")];
    const plan = resolveLaunch("claude", args)!;
    const child = spawn(plan.file, plan.args, {
      cwd: dir, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true as const } : {}),
      // 模型端点指到死端口、key 是占位:init 一到就收手,不会真发请求。
      env: { ...process.env, CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: "ash-test-not-a-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:9", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    });
    let out = "";
    child.stdout!.on("data", (d) => { out += d; if (out.includes('"subtype":"init"')) child.kill(); });
    child.stdin!.end("Say OK");
    const timer = setTimeout(() => child.kill(), 30_000);
    await new Promise((r) => child.once("close", r));
    clearTimeout(timer);
    const init = out.split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
      .find((e) => e.type === "system" && e.subtype === "init");
    assert.ok(init, `真 claude 没给出 init:${out.slice(0, 500)}`);
    assert.deepEqual(init.mcp_servers.filter((s: { name: string }) => s.name === "ash").map((s: { source?: string }) => s.source), ["dynamic"]);
    assert.deepEqual(startedTags(started), ["injected"], `${variant.join(" ") || "默认"}:只拉起排在最后的那份`);
  }
  console.log("✓ 真 claude:同名 ash 以最后一个 --mcp-config 为准(压过用户配置、profile 里更早的那份、--strict-mcp-config)");
}

/**
 * 真 codex app-server:startupStatus 与 mcpServerStatus/list 的真实形状,经产品的
 * `CodexAshMcpStatus` 判。只走到 thread/start,不发 turn/start。
 */
export async function checkRealCodexAppServer(root: string): Promise<void> {
  if (!resolveLaunch("codex", ["app-server", "--stdio"])) { console.log("⚠ 没装 codex,跳过真 app-server 那一段"); return; }
  const { stub } = writeStub(root);
  const entry = (args: string[]) => ({ command: process.execPath, args: [stub, "injected", ...args], env: { ASH_URL: "http://127.0.0.1:9" } });
  const probe = async (config: string, injected: ReturnType<typeof entry>) => {
    const home = mkdtempSync(join(root, "codex-app-"));
    writeFileSync(join(home, "config.toml"), config);
    const launch = resolveLaunch("codex", ["app-server", "--stdio", ...codexAshMcpArgs([], injected)])!;
    const child = spawn(launch.file, launch.args, {
      cwd: home, env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true as const } : {}),
    });
    const status = new CodexAshMcpStatus();
    const said: AgentEvent[] = [];
    const push = (e: AgentEvent) => said.push(e);
    const waiters = new Map<number, (v: unknown) => void>();
    let next = 0;
    let threadId: unknown = null;
    let ashSettled: () => void = () => {};
    const ashDone = new Promise<void>((r) => { ashSettled = r; });
    const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
      const id = ++next;
      waiters.set(id, (v) => ((v as { __error?: unknown })?.__error ? reject(new Error(String((v as { __error: unknown }).__error))) : resolve(v)));
      child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let m: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
      try { m = JSON.parse(line); } catch { return; }
      if (m.id !== undefined && !m.method) { waiters.get(m.id)?.(m.error ? { __error: JSON.stringify(m.error) } : m.result); return; }
      if (m.method !== "mcpServer/startupStatus/updated") return;
      const e = status.update(m.params!);
      if (e) push(e);
      status.checkTools(request, m.params!.threadId ?? threadId, push);
      if (m.params!.name === "ash" && m.params!.status !== "starting") ashSettled();
    });
    try {
      await request("initialize", { clientInfo: { name: "ash-test", version: "1" }, capabilities: { experimentalApi: true } });
      child.stdin!.write('{"method":"initialized"}\n');
      threadId = ((await request("thread/start", { cwd: home, approvalPolicy: "never", sandbox: "danger-full-access" })) as { thread: { id: string } }).thread.id;
      await Promise.race([ashDone, new Promise((r) => setTimeout(r, 15_000))]);
      const e = await status.settle(10_000);
      if (e) push(e);
      return said as Extract<AgentEvent, { kind: "error" }>[];
    } finally {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r(null) : child.once("close", r)));
    }
  };
  const full = entry([...ASH_MCP_TOOLS]);
  assert.deepEqual(await probe("", full), [], "空配置:注入的那条 ready、工具齐全 ⇒ 不出声");
  const narrowed = await probe('[mcp_servers.ash]\ncommand = "node"\ndisabled_tools = ["complete_task", "debate_reply"]\n', full);
  assert.equal(narrowed.length, 1, `用户配置里的 disabled_tools 被深合并保留 ⇒ 一条诊断:${JSON.stringify(narrowed)}`);
  assert.match(narrowed[0]!.message, /complete_task、debate_reply 不在 agent 手上/);
  assert.match(narrowed[0]!.message, /辩论里交不了发言/, "辩论要的那一样也在核对范围里");
  const others = await probe('[mcp_servers.ash]\ncommand = "node"\ndisabled_tools = ["list_groups"]\n', full);
  assert.equal(others[0]?.level, "notice", "只缺非收尾工具 ⇒ 提示级");
  const empty = await probe('[mcp_servers.ash]\ncommand = "node"\nenabled_tools = []\n', full);
  assert.match(empty[0]?.message ?? "", /complete_task 缺了/, "空白名单 ⇒ 收尾出口全缺");
  const legacy = `[mcp_servers.harness]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(stub)}, "legacy", "get_task"]\n`;
  const masked = await probe(legacy, entry(["--die", "600"]));
  assert.equal(masked.length, 1, `历史名先 ready、注入的 ash 后失败 ⇒ 照样说 ash 没接上:${JSON.stringify(masked)}`);
  assert.match(masked[0]!.message, /codex 报告 ash MCP 启动失败/);
  assert.deepEqual(await probe('[mcp_servers.harness]\ncommand = "/nonexistent/legacy-mcp"\n', full), [], "历史名起不来、注入的 ash 好好的 ⇒ 不出声");
  console.log("✓ 真 codex app-server:工具名单被保留时按缺了哪样出声(含辩论/驳回)、历史名先后到达不改结论");
}
