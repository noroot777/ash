// ash 自己的 MCP 起跑时注入、在不在 agent 手上以 CLI 自己报的为准
// (server/src/executors/ash-mcp-inject.ts 注入、ash-mcp-confirm.ts 确认)。
//
//   1. claude:注入文件的内容、按内容复用、不同端口各写各的;写失败的结果只属于那一回合
//   2. 工具清单的单一来源:shared 里的 ASH_MCP_TOOLS 跟 mcp/src 实际注册的逐个对得上
//   3. claude:init 的判据(只认注入那条、来源、全部工具、收尾出口、写失败)+ 经真实的
//      ClaudeExecutor 和假 claude 进程走 run / runSteerable:注入排在全部参数(含 profile 里的
//      `--mcp-config`)之后
//   4. codex:`-c mcp_servers.ash={…}` 的 TOML 转义 —— Windows 路径的反斜杠、带空格的路径;
//      装了 codex 时交给真 codex 解析往返
//   5. codex app-server 的确认:只认注入的名字、工具清单翻页、问不到 / 问挂了 / 到收尾还没回来
//      都说「核实不了」、只说一次;codex exec 按本回合记录判
//   6. 真 CLI(ash-mcp-real-cli-cases.ts):真 claude 的同名优先级、真 codex app-server 的启动报告
//
// codex 起跑参数与回合身份透传的端到端在 `test-codex-mcp-turn-token.ts`。
//
// 跑:npx tsx scripts/test-ash-mcp-inject.ts(cwd = server)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { ASH_MCP_TOOLS, ASH_MCP_TURN_EXITS } from "@ash/shared/mcp";
import { IS_WINDOWS } from "../src/platform.js";
import { REPO_DIR } from "../src/paths.js";

const root = mkdtempSync(join(tmpdir(), "ash-mcp-inject-"));
process.env.ASH_DATA_DIR = join(root, "data");
process.env.ASH_DB = join(root, "ash.db");
delete process.env.ASH_LAX_DONE;

type ErrorEvent = Extract<AgentEvent, { kind: "error" }>;
const isAshProblem = (e: AgentEvent): e is ErrorEvent => e.kind === "error" && e.message.startsWith("ash 的工具在这一回合没接上");
const msg = (e: AgentEvent | null) => (e as ErrorEvent | null)?.message ?? "";
const level = (e: AgentEvent | null) => (e as ErrorEvent | null)?.level;

try {
  const { claudeAshMcpInjection, codexAshMcpArgs, injectsAshMcp } = await import("../src/executors/ash-mcp-inject.js");
  const { claudeAshMcpProblem, CodexAshMcpStatus, CodexExecAshMcp } = await import("../src/executors/ash-mcp-confirm.js");
  const { resolveLaunch } = await import("../src/executors/bin-resolve.js");
  const { checkRealClaudePrecedence, checkRealCodexAppServer } = await import("./ash-mcp-real-cli-cases.js");
  // ClaudeExecutor 那一段会顺手记 Monitor 投影,给它一份建好表的临时库,免得日志里一片报错。
  await (await import("../src/db/index.js")).ensureSchema();

  // ── 1. claude 的注入文件 ──────────────────────────────────────────────────
  {
    const dir = join(root, "claude-mcp");
    const entry = { command: "node", args: ["/code/mcp/dist/index.js"], env: { ASH_URL: "http://127.0.0.1:4317" } };
    const first = claudeAshMcpInjection(dir, entry);
    assert.equal(first.failure, null);
    assert.equal(first.args[0], "--mcp-config");
    const body = JSON.parse(readFileSync(first.args[1]!, "utf8"));
    assert.deepEqual(body, { mcpServers: { ash: { type: "stdio", ...entry } } }, "文件里就是这份 ash 的那一条");
    assert.deepEqual(claudeAshMcpInjection(dir, entry), first, "同内容复用同一个文件");
    const other = claudeAshMcpInjection(dir, { ...entry, env: { ASH_URL: "http://127.0.0.1:14999" } });
    assert.notEqual(other.args[1], first.args[1], "另一个端口的实例各写各的,谁也盖不掉谁");
    assert.equal(JSON.parse(readFileSync(first.args[1]!, "utf8")).mcpServers.ash.env.ASH_URL, "http://127.0.0.1:4317");
    // 写不出来(目录被同名文件占住):结果只属于这一次,之前那次照旧是好的(第 2 轮审查发现 3)
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "");
    const failed = claudeAshMcpInjection(join(blocked, "sub"), entry);
    assert.deepEqual(failed.args, [], "写不出就不注入");
    assert.match(failed.failure ?? "", /写不出注入文件/);
    assert.equal(first.failure, null, "别的回合写失败,不改这一回合的结果");
    assert.ok(injectsAshMcp("claude") && injectsAshMcp("codex") && !injectsAshMcp("gemini"), "注入的只有 claude / codex");
    console.log("✓ claude 注入文件:内容、按内容复用、不同实例互不覆盖、写失败只记在那一回合");
  }

  // ── 2. 工具清单的单一来源 ─────────────────────────────────────────────────
  {
    const registered: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, name.name);
        if (name.isDirectory()) walk(path);
        else if (name.name.endsWith(".ts")) {
          for (const m of readFileSync(path, "utf8").matchAll(/registerTool\(\s*"([a-z_]+)"/g)) registered.push(m[1]!);
        }
      }
    };
    walk(join(REPO_DIR, "mcp", "src"));
    assert.deepEqual([...registered].sort(), [...ASH_MCP_TOOLS].sort(), "ASH_MCP_TOOLS 要跟 mcp/src 里注册的工具逐个对得上");
    for (const exit of Object.keys(ASH_MCP_TURN_EXITS)) assert.ok((ASH_MCP_TOOLS as readonly string[]).includes(exit), `收尾出口 ${exit} 必须是 ash 注册的工具`);
    console.log(`✓ 工具清单单一来源:ASH_MCP_TOOLS 与 mcp/src 注册的 ${registered.length} 个工具一致`);
  }

  // ── 3. claude:init 的判据 + 经 ClaudeExecutor 的接线 ──────────────────────
  {
    const ok = { args: ["--mcp-config", "/x.json"], failure: null };
    const ALL = ASH_MCP_TOOLS.map((t) => `mcp__ash__${t}`);
    const without = (...names: string[]) => ALL.filter((t) => !names.some((n) => t === `mcp__ash__${n}`));
    const injected = { name: "ash", status: "connected", source: "dynamic" };
    assert.equal(claudeAshMcpProblem(ok, [injected], ["Bash", ...ALL]), null);
    assert.equal(claudeAshMcpProblem(ok, [{ name: "ash", status: "connected" }], ALL), null, "老版本不报 source:按连上算");
    // 只认注入的那个名字:历史名 harness 连着也不替 ash 作证
    assert.match(msg(claudeAshMcpProblem(ok, [{ name: "harness", status: "connected", source: "user" }], ALL)), /清单里没有 ash/);
    assert.match(msg(claudeAshMcpProblem(ok, [{ ...injected, status: "failed" }, { name: "harness", status: "connected" }], ALL)), /状态是 failed/);
    // 连上的是用户配置里那条 ⇒ 注入没生效
    assert.match(msg(claudeAshMcpProblem(ok, [{ ...injected, source: "user" }], ALL)), /注入没生效.*来源 user/);
    // 这一回合自己写失败了 ⇒ 不拿 connected 抵消;别的回合写失败不影响这一回合
    const failedInjection = { args: [], failure: "写不出注入文件 /x：ENOSPC" };
    assert.match(msg(claudeAshMcpProblem(failedInjection, [injected], ALL)), /注入没生效.*写不出注入文件 \/x：ENOSPC/);
    assert.equal(claudeAshMcpProblem(ok, [injected], ALL), null);
    // 工具被限制:收尾出口缺了是红的、逐样说后果;只缺别的是提示
    const exitsGone = claudeAshMcpProblem(ok, [injected], without("complete_task", "debate_reply"));
    assert.ok(isAshProblem(exitsGone!) && level(exitsGone) === undefined);
    assert.match(msg(exitsGone), /complete_task、debate_reply 不在 agent 手上/);
    assert.match(msg(exitsGone), /complete_task 缺了，需要确认完成的回合会记未完成；debate_reply 缺了，辩论里交不了发言/);
    assert.match(msg(claudeAshMcpProblem(ok, [injected], without("dispute_review"))), /驳不了审查意见/);
    const minor = claudeAshMcpProblem(ok, [injected], without("list_groups"));
    assert.equal(level(minor), "notice", "只缺非收尾工具 ⇒ 提示级");
    assert.match(msg(minor), /list_groups 不在 agent 手上/);
    assert.equal(level(claudeAshMcpProblem(ok, [injected])), "notice", "init 里没有工具清单 ⇒ 核实不了(提示),不冒充没问题");
    const failedOne = claudeAshMcpProblem(ok, [{ name: "ash", status: "failed" }]) as ErrorEvent;
    assert.match(failedOne.message, /状态是 failed/);
    assert.equal(failedOne.affectsTurn, false, "诊断不改本回合成败");
    process.env.ASH_LAX_DONE = "1";
    assert.equal(claudeAshMcpProblem(ok, []), null, "宽松完成协议的环境本来就不靠 ash MCP,不出声");
    assert.equal(claudeAshMcpProblem(ok, [injected], without("complete_task")), null);
    delete process.env.ASH_LAX_DONE;

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
    // profile 里自带一份同名的 `--mcp-config`:注入必须排在它后面(真 claude 以最后一份为准,见第 6 段)
    const profileConfig = join(root, "profile-mcp.json");
    const executor = new ClaudeExecutor({ bin, extraArgs: ["--mcp-config", profileConfig] });
    const run = async (mode: "run" | "runSteerable", servers: unknown, tools: string[] = ALL) => {
      process.env.FAKE_MCP = JSON.stringify(servers);
      process.env.FAKE_TOOLS = JSON.stringify(tools);
      const handle = executor[mode]({ cwd: root, prompt: "hi", extraArgs: ["--add-dir", root] });
      const seen: AgentEvent[] = [];
      for await (const e of handle.events) seen.push(e);
      await handle.cleanup?.();
      return { seen, argv: JSON.parse(readFileSync(process.env.FAKE_CLAUDE_ARGV!, "utf8")) as string[] };
    };
    for (const mode of ["run", "runSteerable"] as const) {
      const good = await run(mode, [injected]);
      const at = good.argv.lastIndexOf("--mcp-config");
      assert.equal(at, good.argv.length - 2, `${mode}:注入的 --mcp-config 排在最后:${good.argv.join(" ")}`);
      assert.notEqual(good.argv[at + 1], profileConfig, "最后那份是注入的,不是 profile 那份");
      assert.ok(existsSync(good.argv[at + 1]!), "指向的注入文件在盘上");
      assert.ok(good.argv.indexOf(profileConfig) < at && good.argv.indexOf("--add-dir") < at, "排在 profile 与本次 extraArgs 之后");
      assert.deepEqual(good.seen.filter(isAshProblem), [], `${mode}:接上了不出声`);
      const bad = (await run(mode, [{ ...injected, status: "failed" }])).seen.filter(isAshProblem);
      assert.equal(bad.length, 1, `${mode}:claude 报 failed ⇒ 一条诊断`);
      assert.match(bad[0]!.message, /claude 启动时报告 ash MCP 的状态是 failed/);
      const narrowed = (await run(mode, [injected], without("pause_task"))).seen.filter(isAshProblem);
      assert.equal(narrowed.length, 1, `${mode}:init 里的工具清单缺了收尾出口 ⇒ 经执行器也出声`);
      assert.match(narrowed[0]!.message, /pause_task 不在 agent 手上/);
    }
    console.log("✓ claude init 判据(只认注入那条、来源、全部工具、收尾出口、写失败归属) + run / runSteerable 的接线与参数位置");
  }

  // ── 4. codex:TOML 转义 ─────────────────────────────────────────────────────
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

  // ── 5. codex:启动状态与工具清单的判据 ─────────────────────────────────────
  {
    const tools = (names: readonly string[]) => Object.fromEntries(names.map((t) => [t, {}]));
    const page = (data: unknown[], nextCursor: string | null = null) => ({ data, nextCursor });
    const said: AgentEvent[] = [];
    const push = (e: AgentEvent) => said.push(e);
    const readied = (request: (m: string, p: unknown) => Promise<unknown>) => {
      const s = new CodexAshMcpStatus();
      s.update({ name: "ash", status: "starting" });
      assert.equal(s.update({ name: "ash", status: "ready" }), null);
      s.checkTools(request, "thread-1", push);
      return s;
    };

    // 翻页:ash 在第二页
    const asked: unknown[] = [];
    const paged = readied(async (_m, p) => {
      asked.push(p);
      return (p as { cursor: unknown }).cursor ? page([{ name: "ash", tools: tools(ASH_MCP_TOOLS) }]) : page([{ name: "kb", tools: {} }], "c2");
    });
    assert.equal(await paged.settle(), null, "翻到第二页找到 ash、工具齐全 ⇒ 不出声");
    assert.deepEqual(asked.map((p) => (p as { cursor: unknown }).cursor), [null, "c2"], "跟着 nextCursor 翻完");
    assert.deepEqual(said, []);

    // 缺收尾出口 ⇒ 问到当场说,收尾不再重复
    const narrowed = readied(async () => page([{ name: "ash", tools: tools(ASH_MCP_TOOLS.filter((t) => t !== "debate_reply")) }]));
    assert.equal(await narrowed.settle(), null, "问到时已经说过,收尾不重复");
    assert.equal(said.length, 1);
    assert.match(msg(said[0]!), /codex 连上了 ash，但 debate_reply 不在 agent 手上.*辩论里交不了发言/);
    said.length = 0;

    // 问不到:超时 / 出错 / 应答认不出 / 没有 ash ⇒ 核实不了(提示级),不折回没问题
    const hung = readied(() => new Promise(() => {}));
    const hungSaid = await hung.settle(50);
    assert.equal(level(hungSaid), "notice");
    assert.match(msg(hungSaid), /工具清单没拿到（到回合收尾还没问到）/);
    assert.match(msg(await readied(async () => { throw new Error("Codex mcpServerStatus/list 超时"); }).settle()), /工具清单没拿到（Codex mcpServerStatus\/list 超时）/);
    assert.match(msg(await readied(async () => ({ nope: 1 })).settle()), /应答里没有 data 列表/);
    assert.match(msg(await readied(async () => page([{ name: "kb", tools: {} }])).settle()), /清单里没有 ash/);
    const neverAsked = new CodexAshMcpStatus();
    neverAsked.update({ name: "ash", status: "ready" });
    assert.match(msg(await neverAsked.settle()), /ash 就绪之后没有问到/);
    assert.deepEqual(said, [], "问不到时不当场乱说");

    // 启动状态:失败带原话、只说一次;没加载 / 没启动完;别家与历史名不归这里说
    const failed = new CodexAshMcpStatus();
    assert.equal(failed.update({ name: "kb", status: "failed" }), null, "别家的 MCP 不归这里说");
    const told = failed.update({ name: "ash", status: "failed", error: "MCP client for `ash` timed out after 30 seconds." });
    assert.match(msg(told), /启动失败：MCP client for `ash` timed out/, "带上 codex 的原话");
    assert.equal(await failed.settle(), null, "说过了就不再说");
    assert.match(msg(await new CodexAshMcpStatus().settle()), /没有加载 ash MCP/);
    const stuck = new CodexAshMcpStatus();
    stuck.update({ name: "ash", status: "starting" });
    assert.match(msg(await stuck.settle()), /一直没启动完成/);
    const legacyFirst = new CodexAshMcpStatus();
    legacyFirst.update({ name: "harness", status: "ready" });
    assert.match(msg(legacyFirst.update({ name: "ash", status: "failed", error: "handshake" })), /启动失败/, "历史名先 ready 也不替 ash 作证");
    const legacyFailed = new CodexAshMcpStatus();
    assert.equal(legacyFailed.update({ name: "harness", status: "failed", error: "gone" }), null, "历史名坏了不说 ash 的事");

    // exec 那条路:按本回合记录判
    const used = new CodexExecAshMcp();
    used.item({ type: "mcp_tool_call", server: "ash", tool: "complete_task", status: "completed" });
    assert.equal(used.settle(), null, "调成过 ash 的工具 ⇒ 接上了");
    const crashed = new CodexExecAshMcp();
    crashed.stderr("2026-11-14T08:00:00Z ERROR codex_core::mcp: MCP client for `ash` failed to start: handshake closed\n");
    const crashedSaid = crashed.settle();
    assert.match(msg(crashedSaid), /^ash 的工具在这一回合没接上（codex 报告 ash MCP 启动失败：.*handshake closed/);
    assert.equal(level(crashedSaid), undefined, "点名失败的是红色诊断");
    const brokenCall = new CodexExecAshMcp();
    brokenCall.item({ type: "mcp_tool_call", server: "ash", tool: "complete_task", status: "failed" });
    const unknown = brokenCall.settle();
    assert.equal(level(unknown), "notice", "没有证据只说核实不了,提示级");
    assert.match(msg(unknown), /codex exec，这条路上 codex 不报 ash MCP 连没连上/);
    const split = new CodexExecAshMcp();
    split.stderr("MCP server `ash` failed to st");
    split.stderr("art and is unavailable. Continue without it.");
    assert.match(msg(split.settle()), /启动失败：MCP server `ash` failed to start/, "跨块切开、没有换行收尾的那一行也认");
    console.log("✓ codex 确认:翻页、缺哪样说哪样、问不到说核实不了、只认注入的名字、只说一次;exec 按本回合记录判");
  }

  // ── 6. 真 CLI ────────────────────────────────────────────────────────────
  await checkRealClaudePrecedence(root);
  await checkRealCodexAppServer(root);
} finally {
  rmSync(root, { recursive: true, force: true });
}
