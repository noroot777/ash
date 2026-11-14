// ash 自己的 MCP 起跑时注入、连没连上以 CLI 自己报的为准(server/src/executors/ash-mcp-inject.ts)。
//
//   1. claude:`--mcp-config <文件>` 排在别的 flag 前面,文件内容就是这份 ash 的入口 + 端口;
//      按内容取名,同内容复用、不同端口各写各的
//   2. claude:init 里 ash 没连上 / 连上的不是注入那条(source≠dynamic、注入文件写不出)/ 协议工具
//      不在 tools 里 ⇒ 一条诊断;都好 ⇒ 不出声;经真实的 ClaudeExecutor + 假 claude 进程走一遍
//   3. codex:`-c mcp_servers.ash={…}` 的 TOML 转义 —— Windows 路径的反斜杠、带空格的路径;
//      装了 codex 时交给真 codex(`codex -c … mcp list --json`,只读配置、不花额度)解析往返
//   4. codex:启动状态的判据(只认注入的名字、ready 后核工具清单、failed 带原话、没报 / 没启动完、
//      只说一次);exec 那条路按本回合记录判
//   5. 真 codex app-server + 自带的 MCP 桩:用户配置里的工具名单被保留时出声、历史名先后到达不改结论
//
// codex 起跑参数与回合身份透传的端到端在 `test-codex-mcp-turn-token.ts`。
//
// 跑:npx tsx scripts/test-ash-mcp-inject.ts(cwd = server)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentEvent } from "@ash/shared";
import { IS_WINDOWS } from "../src/platform.js";

const root = mkdtempSync(join(tmpdir(), "ash-mcp-inject-"));
process.env.ASH_DATA_DIR = join(root, "data");
process.env.ASH_DB = join(root, "ash.db");
delete process.env.ASH_LAX_DONE;

const PROTOCOL = ["complete_task", "pause_task", "ask_question", "report_stage"];
const isAshProblem = (e: AgentEvent): e is Extract<AgentEvent, { kind: "error" }> =>
  e.kind === "error" && e.message.startsWith("ash 的工具在这一回合没接上");

try {
  const {
    claudeAshMcpArgs, claudeAshMcpProblem, codexAshMcpArgs, CodexAshMcpStatus, CodexExecAshMcp, injectsAshMcp,
  } = await import("../src/executors/ash-mcp-inject.js");
  const { resolveLaunch } = await import("../src/executors/bin-resolve.js");
  // ClaudeExecutor 那一段会顺手记 Monitor 投影,给它一份建好表的临时库,免得日志里一片报错。
  await (await import("../src/db/index.js")).ensureSchema();

  // ── 1. claude 的注入文件 ──────────────────────────────────────────────────
  {
    const dir = join(root, "claude-mcp");
    const entry = { command: "node", args: ["/code/mcp/dist/index.js"], env: { ASH_URL: "http://127.0.0.1:4317" } };
    const args = claudeAshMcpArgs(dir, entry);
    assert.equal(args[0], "--mcp-config");
    const body = JSON.parse(readFileSync(args[1]!, "utf8"));
    assert.deepEqual(body, { mcpServers: { ash: { type: "stdio", ...entry } } }, "文件里就是这份 ash 的那一条");
    assert.deepEqual(claudeAshMcpArgs(dir, entry), args, "同内容复用同一个文件");
    const other = claudeAshMcpArgs(dir, { ...entry, env: { ASH_URL: "http://127.0.0.1:14999" } });
    assert.notEqual(other[1], args[1], "另一个端口的实例各写各的,谁也盖不掉谁");
    assert.equal(JSON.parse(readFileSync(args[1]!, "utf8")).mcpServers.ash.env.ASH_URL, "http://127.0.0.1:4317");
    assert.ok(injectsAshMcp("claude") && injectsAshMcp("codex") && !injectsAshMcp("gemini"), "注入的只有 claude / codex");
    console.log("✓ claude 注入文件:内容、按内容复用、不同实例互不覆盖");
  }

  // ── 2. claude:init 的判据 + 经 ClaudeExecutor 的接线 ──────────────────────
  {
    const msg = (e: AgentEvent | null) => (e as { message: string } | null)?.message ?? "";
    const ALL = ["complete_task", "pause_task", "ask_question", "report_stage", "get_task"].map((t) => `mcp__ash__${t}`);
    const injected = { name: "ash", status: "connected", source: "dynamic" };
    assert.equal(claudeAshMcpProblem([injected], ["Bash", ...ALL]), null);
    assert.equal(claudeAshMcpProblem([{ name: "ash", status: "connected" }], ALL), null, "老版本不报 source:按连上算");
    // 只认注入的那个名字:历史名 harness 连着也不替 ash 作证(第 1 轮审查发现 3)
    assert.match(msg(claudeAshMcpProblem([{ name: "harness", status: "connected", source: "user" }], ALL)), /清单里没有 ash/);
    assert.match(msg(claudeAshMcpProblem([{ ...injected, status: "failed" }, { name: "harness", status: "connected" }], ALL)), /状态是 failed/);
    // 连上的是用户配置里那条 ⇒ 注入没生效,不拿它冒充接上了(发现 4)
    assert.match(msg(claudeAshMcpProblem([{ ...injected, source: "user" }], ALL)), /注入没生效.*来源 user/);
    // 连上了但协议工具被限制掉(--disallowedTools / 配置里的工具名单;发现 1)
    const filtered = msg(claudeAshMcpProblem([injected], ALL.filter((t) => !t.endsWith("complete_task"))));
    assert.match(filtered, /连上了 ash，但 complete_task 不在 agent 手上/);
    assert.match(filtered, /complete_task 都用不了，需要确认完成的回合会记未完成/, "只点名真缺的那一样");
    assert.match(msg(claudeAshMcpProblem([injected], ALL.filter((t) => !t.endsWith("report_stage")))), /审查回合报不上结论/);
    const failedOne = claudeAshMcpProblem([{ name: "ash", status: "failed" }]) as { message: string; affectsTurn?: boolean };
    assert.match(failedOne.message, /状态是 failed/);
    assert.equal(failedOne.affectsTurn, false, "诊断不改本回合成败");
    process.env.ASH_LAX_DONE = "1";
    assert.equal(claudeAshMcpProblem([]), null, "宽松完成协议的环境本来就不靠 ash MCP,不出声");
    delete process.env.ASH_LAX_DONE;
    // 注入文件写不出来(目录被同名文件占住)⇒ claude 退回自己配置里那条;init 照样说没注入上、带原因
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "");
    assert.deepEqual(claudeAshMcpArgs(join(blocked, "sub")), [], "写不出就不注入");
    assert.match(msg(claudeAshMcpProblem([injected], ALL)), /写不出注入文件/, "写失败不能被一条 connected 抵消");
    assert.equal(claudeAshMcpArgs(join(root, "claude-mcp-ok"))[0], "--mcp-config");
    assert.equal(claudeAshMcpProblem([injected], ALL), null, "写成了就清掉那条失败");

    const script = join(root, "fake-claude.mjs");
    const bin = IS_WINDOWS ? join(root, "fake-claude.cmd") : script;
    writeFileSync(script, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_CLAUDE_ARGV, JSON.stringify(process.argv.slice(2)));
const sid = "00000000-0000-4000-8000-000000000001";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: sid, cwd: process.cwd(), tools: JSON.parse(process.env.FAKE_TOOLS), mcp_servers: JSON.parse(process.env.FAKE_MCP) });
out({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: sid, usage: {} });
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`);
    if (IS_WINDOWS) writeFileSync(bin, `@node "%~dp0fake-claude.mjs" %*\r\n`);
    else chmodSync(bin, 0o755);
    process.env.FAKE_CLAUDE_ARGV = join(root, "claude-argv.json");
    const { ClaudeExecutor } = await import("../src/executors/claude.js");
    const run = async (servers: unknown, tools: string[] = ALL) => {
      process.env.FAKE_MCP = JSON.stringify(servers);
      process.env.FAKE_TOOLS = JSON.stringify(tools);
      const handle = new ClaudeExecutor({ bin }).run({ cwd: root, prompt: "hi", extraArgs: ["--add-dir", root] });
      const seen: AgentEvent[] = [];
      for await (const e of handle.events) seen.push(e);
      await handle.cleanup?.();
      return { seen, argv: JSON.parse(readFileSync(process.env.FAKE_CLAUDE_ARGV!, "utf8")) as string[], handle };
    };
    const ok = await run([{ name: "ash", status: "connected", source: "dynamic" }]);
    const at = ok.argv.indexOf("--mcp-config");
    assert.ok(at > 0, `claude 起跑参数里要有 --mcp-config:${ok.argv.join(" ")}`);
    assert.ok(ok.argv[at + 2]?.startsWith("--"), "变长参数后面紧跟的必须是另一个 flag,不能吞掉位置参数");
    assert.ok(existsSync(ok.argv[at + 1]!), "指向的注入文件在盘上");
    assert.ok(ok.argv.indexOf("--add-dir") > at, "排在用户 extraArgs 前面");
    assert.deepEqual(ok.seen.filter(isAshProblem), [], "连上了不出声");
    const bad = await run([{ name: "ash", status: "failed", source: "dynamic" }]);
    const told = bad.seen.filter(isAshProblem);
    assert.equal(told.length, 1, `claude 报 failed ⇒ 一条诊断:${JSON.stringify(bad.seen.map((e) => e.kind))}`);
    assert.match(told[0]!.message, /claude 启动时报告 ash MCP 的状态是 failed/);
    const narrowed = (await run([{ name: "ash", status: "connected", source: "dynamic" }], ALL.filter((t) => !t.endsWith("pause_task")))).seen.filter(isAshProblem);
    assert.equal(narrowed.length, 1, "init 里的工具清单缺了协议工具 ⇒ 经执行器也出声");
    assert.match(narrowed[0]!.message, /pause_task 不在 agent 手上/);
    console.log("✓ claude init 判据(只认注入那条、来源、工具清单、写失败) + 经 ClaudeExecutor 的接线");
  }

  // ── 3. codex:TOML 转义 ─────────────────────────────────────────────────────
  {
    const winEntry = {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["D:\\ai_workspace\\ash\\mcp\\dist\\index.js"],
      env: { ASH_URL: "http://127.0.0.1:4317" },
    };
    const [flag, value] = codexAshMcpArgs(["ASH_TASK_ID", "ASH_TURN_TOKEN"], winEntry);
    assert.equal(flag, "-c");
    assert.equal(value, 'mcp_servers.ash={command="C:\\\\Program Files\\\\nodejs\\\\node.exe",'
      + 'args=["D:\\\\ai_workspace\\\\ash\\\\mcp\\\\dist\\\\index.js"],env={ASH_URL="http://127.0.0.1:4317"},'
      + 'enabled=true,env_vars=["ASH_TASK_ID","ASH_TURN_TOKEN"]}');
    assert.ok(!codexAshMcpArgs([], winEntry)[1]!.includes("env_vars"), "没有回合身份(非任务回合)就不写 env_vars");
    const plan = resolveLaunch("codex", ["-c", value!, "mcp", "list", "--json"]);
    if (plan) {
      const home = join(root, "codex-home");
      mkdirSync(home, { recursive: true });
      const res = spawnSync(plan.file, plan.args, {
        cwd: home, encoding: "utf8", windowsHide: true, timeout: 30_000,
        env: { ...process.env, CODEX_HOME: home },
        ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true as const } : {}),
      });
      assert.equal(res.status, 0, `真 codex 读得通这条覆盖:${res.stderr}`);
      const listed = (JSON.parse(res.stdout) as { name: string; enabled: boolean; transport: Record<string, unknown> }[])
        .find((s) => s.name === "ash");
      assert.ok(listed?.enabled, "真 codex 列出了开着的 ash");
      assert.equal(listed!.transport.command, winEntry.command, "反斜杠和空格原样往返");
      assert.deepEqual(listed!.transport.args, winEntry.args);
      assert.deepEqual(listed!.transport.env, winEntry.env);
      assert.deepEqual(listed!.transport.env_vars, ["ASH_TASK_ID", "ASH_TURN_TOKEN"]);
      console.log("✓ codex 注入的 TOML:Windows 路径与空格经真 codex 解析原样往返");
    } else {
      console.log("⚠ 没装 codex,TOML 往返只核了字面量");
    }
  }

  // ── 4. codex:启动状态的判据 ───────────────────────────────────────────────
  {
    const msg = (e: AgentEvent | null) => (e as { message: string } | null)?.message ?? "";
    const ready = new CodexAshMcpStatus();
    assert.equal(ready.update({ name: "kb", status: "failed" }), null, "别家的 MCP 不归这里说");
    assert.equal(ready.update({ name: "ash", status: "starting" }), null);
    assert.equal(ready.wantsToolList(), false, "还没 ready 不问工具清单");
    assert.equal(ready.update({ name: "ash", status: "ready" }), null);
    assert.equal(ready.wantsToolList(), true, "ready 之后问一次");
    assert.equal(ready.wantsToolList(), false, "只问一次");
    assert.equal(ready.tools({ data: [{ name: "ash", tools: Object.fromEntries(PROTOCOL.map((t) => [t, {}])) }] }), null);
    assert.equal(ready.settle(), null, "ready ⇒ 收尾也不出声");

    const failed = new CodexAshMcpStatus();
    const told = failed.update({ name: "ash", status: "failed", error: "MCP client for `ash` timed out after 30 seconds." });
    assert.match(msg(told), /启动失败：MCP client for `ash` timed out/, "带上 codex 的原话");
    assert.equal(failed.settle(), null, "说过了就不再说");

    assert.match(msg(new CodexAshMcpStatus().settle()), /没有加载 ash MCP/);
    const stuck = new CodexAshMcpStatus();
    stuck.update({ name: "ash", status: "starting" });
    assert.match(msg(stuck.settle()), /一直没启动完成/);

    // 历史名不替 ash 作证,两种到达顺序结论一样(第 1 轮审查发现 3)
    const legacyFirst = new CodexAshMcpStatus();
    legacyFirst.update({ name: "harness", status: "ready" });
    assert.match(msg(legacyFirst.update({ name: "ash", status: "failed", error: "handshake" })), /启动失败/);
    const legacyFailed = new CodexAshMcpStatus();
    assert.equal(legacyFailed.update({ name: "harness", status: "failed", error: "gone" }), null, "历史名坏了不说 ash 的事");
    legacyFailed.update({ name: "ash", status: "ready" });
    assert.equal(legacyFailed.settle(), null);

    // ready 了但协议工具被配置里的工具名单挡掉(发现 1)
    const narrowed = new CodexAshMcpStatus();
    narrowed.update({ name: "ash", status: "ready" });
    narrowed.wantsToolList();
    assert.match(msg(narrowed.tools({ data: [{ name: "ash", tools: { get_task: {}, pause_task: {}, ask_question: {}, report_stage: {} } }] })),
      /codex 连上了 ash，但 complete_task 不在 agent 手上/);
    assert.equal(narrowed.settle(), null, "说过了就不再说");
    assert.equal(new CodexAshMcpStatus().tools({ nope: 1 }), null, "认不出应答形状不下结论");

    // exec 那条路:按本回合记录判(发现 2)
    const used = new CodexExecAshMcp();
    used.item({ type: "mcp_tool_call", server: "ash", tool: "complete_task", status: "completed" });
    assert.equal(used.settle(), null, "调成过 ash 的工具 ⇒ 接上了");
    const brokenCall = new CodexExecAshMcp();
    brokenCall.item({ type: "mcp_tool_call", server: "ash", tool: "complete_task", status: "failed" });
    const crashed = new CodexExecAshMcp();
    crashed.stderr("2026-11-14T08:00:00Z ERROR codex_core::mcp: MCP client for `ash` failed to start: handshake closed\n");
    const crashedSaid = crashed.settle() as Extract<AgentEvent, { kind: "error" }>;
    assert.match(crashedSaid.message, /^ash 的工具在这一回合没接上（codex 报告 ash MCP 启动失败：.*handshake closed/);
    assert.equal(crashedSaid.level, undefined, "点名失败的是红色诊断");
    const unknown = brokenCall.settle() as Extract<AgentEvent, { kind: "error" }>;
    assert.equal(unknown.level, "notice", "没有证据只说核实不了,提示级");
    assert.match(unknown.message, /codex exec，这条路上 codex 不报 ash MCP 连没连上/);
    const split = new CodexExecAshMcp();
    split.stderr("MCP server `ash` failed to st");
    split.stderr("art and is unavailable. Continue without it.");
    assert.match(msg(split.settle()), /启动失败：MCP server `ash` failed to start/, "跨块切开、没有换行收尾的那一行也认");
    console.log("✓ codex 启动状态:只认注入的名字、工具清单、exec 按本回合记录判、只说一次");
  }

  // ── 5. 真 codex app-server:startupStatus 与 mcpServerStatus/list 的真实形状 ─────────
  //    MCP 服务是个自带的最小桩(只答 initialize / tools/list),不依赖 mcp/dist 有没有 build。
  //    只走到 thread/start,不发 turn/start,不调模型、不花额度。
  {
    const plan = resolveLaunch("codex", ["app-server", "--stdio"]);
    if (!plan) {
      console.log("⚠ 没装 codex,跳过真 app-server 那一段");
    } else {
      const stub = join(root, "mcp-stub.mjs");
      writeFileSync(stub, `import { createInterface } from "node:readline";
const tools = process.argv.slice(2);
// --die <ms>:握手不答、过一会儿退出 —— 一条起不来的 MCP 服务
if (tools[0] === "--die") setTimeout(() => process.exit(1), Number(tools[1]));
else createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  if (m.method === "initialize") send({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } });
  else if (m.method === "tools/list") send({ tools: tools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })) });
  else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nope" } }) + "\\n");
});
`);
      const stubEntry = (args: string[]) => ({ command: process.execPath, args: [stub, ...args], env: { ASH_URL: "http://127.0.0.1:9" } });
      const probe = async (config: string, entry: ReturnType<typeof stubEntry>) => {
        const home = mkdtempSync(join(root, "codex-app-"));
        writeFileSync(join(home, "config.toml"), config);
        const launch = resolveLaunch("codex", ["app-server", "--stdio", ...codexAshMcpArgs([], entry)])!;
        const child = spawn(launch.file, launch.args, {
          cwd: home, env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
          ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true as const } : {}),
        });
        const status = new CodexAshMcpStatus();
        const said: AgentEvent[] = [];
        const waiters = new Map<number, (v: unknown) => void>();
        let next = 0;
        let settledAsh: () => void = () => {};
        const ashDone = new Promise<void>((r) => { settledAsh = r; });
        createInterface({ input: child.stdout! }).on("line", (line) => {
          let m: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
          try { m = JSON.parse(line); } catch { return; }
          if (m.id !== undefined && !m.method) { waiters.get(m.id)?.(m.result ?? m.error); return; }
          if (m.method === "mcpServer/startupStatus/updated") {
            const e = status.update(m.params!);
            if (e) said.push(e);
            if (m.params!.name === "ash" && m.params!.status !== "starting") settledAsh();
          }
        });
        const call = (method: string, params: unknown) => new Promise<unknown>((resolve) => {
          const id = ++next;
          waiters.set(id, resolve);
          child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
        });
        try {
          await call("initialize", { clientInfo: { name: "ash-test", version: "1" }, capabilities: { experimentalApi: true } });
          child.stdin!.write('{"method":"initialized"}\n');
          const thread = await call("thread/start", { cwd: home, approvalPolicy: "never", sandbox: "danger-full-access" }) as { thread: { id: string } };
          await Promise.race([ashDone, new Promise((r) => setTimeout(r, 15_000))]);
          if (status.wantsToolList()) {
            const e = status.tools(await call("mcpServerStatus/list", { threadId: thread.thread.id, limit: 100 }));
            if (e) said.push(e);
          }
          const e = status.settle();
          if (e) said.push(e);
          return said.map((x) => (x as { message: string }).message);
        } finally {
          child.kill();
          await new Promise((r) => (child.exitCode !== null ? r(null) : child.once("close", r)));
        }
      };
      const FULL = ["complete_task", "pause_task", "ask_question", "report_stage", "get_task"];
      assert.deepEqual(await probe("", stubEntry(FULL)), [], "空配置:注入的那条 ready、工具齐全 ⇒ 不出声");
      const narrowed = await probe('[mcp_servers.ash]\ncommand = "node"\ndisabled_tools = ["complete_task"]\n', stubEntry(FULL));
      assert.equal(narrowed.length, 1, `用户配置里的 disabled_tools 被深合并保留 ⇒ 一条诊断:${JSON.stringify(narrowed)}`);
      assert.match(narrowed[0]!, /complete_task 不在 agent 手上/);
      const empty = await probe('[mcp_servers.ash]\ncommand = "node"\nenabled_tools = []\n', stubEntry(FULL));
      assert.match(empty[0] ?? "", /complete_task、pause_task、ask_question、report_stage 不在 agent 手上/, "空白名单 ⇒ 四样都缺");
      const legacy = `[mcp_servers.harness]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(stub)}, "get_task"]\n`;
      const masked = await probe(legacy, stubEntry(["--die", "600"]));
      assert.equal(masked.length, 1, `历史名先 ready、注入的 ash 后失败 ⇒ 照样说 ash 没接上:${JSON.stringify(masked)}`);
      assert.match(masked[0]!, /codex 报告 ash MCP 启动失败/);
      const legacyBroken = await probe('[mcp_servers.harness]\ncommand = "/nonexistent/legacy-mcp"\n', stubEntry(FULL));
      assert.deepEqual(legacyBroken, [], "历史名起不来、注入的 ash 好好的 ⇒ 不出声");
      console.log("✓ 真 codex app-server:工具名单被保留时出声、历史名先后到达不改结论");
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
