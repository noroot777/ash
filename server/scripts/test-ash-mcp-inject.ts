// ash 自己的 MCP 起跑时注入、连没连上以 CLI 自己报的为准(server/src/executors/ash-mcp-inject.ts)。
//
//   1. claude:`--mcp-config <文件>` 排在别的 flag 前面,文件内容就是这份 ash 的入口 + 端口;
//      按内容取名,同内容复用、不同端口各写各的
//   2. claude:init 里 ash 没连上(failed / 清单里压根没有)⇒ 一条诊断;连上了 ⇒ 不出声;
//      经真实的 ClaudeExecutor + 假 claude 进程走一遍,钉住接线
//   3. codex:`-c mcp_servers.ash={…}` 的 TOML 转义 —— Windows 路径的反斜杠、带空格的路径;
//      装了 codex 时交给真 codex(`codex -c … mcp list --json`,只读配置、不花额度)解析往返
//   4. codex:启动状态的判据(ready 不出声、failed 带原话、从头到尾没报、一直没启动完、只说一次)
//
// codex 起跑参数与回合身份透传的端到端在 `test-codex-mcp-turn-token.ts`。
//
// 跑:npx tsx scripts/test-ash-mcp-inject.ts(cwd = server)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { IS_WINDOWS } from "../src/platform.js";

const root = mkdtempSync(join(tmpdir(), "ash-mcp-inject-"));
process.env.ASH_DATA_DIR = join(root, "data");
process.env.ASH_DB = join(root, "ash.db");
delete process.env.ASH_LAX_DONE;

const isAshProblem = (e: AgentEvent): e is Extract<AgentEvent, { kind: "error" }> =>
  e.kind === "error" && e.message.startsWith("ash 的工具在这一回合没接上");

try {
  const {
    claudeAshMcpArgs, claudeAshMcpProblem, codexAshMcpArgs, CodexAshMcpStatus, injectsAshMcp,
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
    assert.equal(claudeAshMcpProblem([{ name: "ash", status: "connected" }]), null);
    assert.equal(claudeAshMcpProblem([{ name: "harness", status: "connected" }]), null, "历史名连上了也算");
    assert.match((claudeAshMcpProblem([{ name: "kb", status: "connected" }]) as { message: string }).message, /清单里没有 ash/);
    const failedOne = claudeAshMcpProblem([{ name: "ash", status: "failed" }]) as { message: string; affectsTurn?: boolean };
    assert.match(failedOne.message, /状态是 failed/);
    assert.equal(failedOne.affectsTurn, false, "诊断不改本回合成败");
    process.env.ASH_LAX_DONE = "1";
    assert.equal(claudeAshMcpProblem([]), null, "宽松完成协议的环境本来就不靠 ash MCP,不出声");
    delete process.env.ASH_LAX_DONE;

    const script = join(root, "fake-claude.mjs");
    const bin = IS_WINDOWS ? join(root, "fake-claude.cmd") : script;
    writeFileSync(script, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_CLAUDE_ARGV, JSON.stringify(process.argv.slice(2)));
const sid = "00000000-0000-4000-8000-000000000001";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: sid, cwd: process.cwd(), tools: [], mcp_servers: JSON.parse(process.env.FAKE_MCP) });
out({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: sid, usage: {} });
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`);
    if (IS_WINDOWS) writeFileSync(bin, `@node "%~dp0fake-claude.mjs" %*\r\n`);
    else chmodSync(bin, 0o755);
    process.env.FAKE_CLAUDE_ARGV = join(root, "claude-argv.json");
    const { ClaudeExecutor } = await import("../src/executors/claude.js");
    const run = async (servers: unknown) => {
      process.env.FAKE_MCP = JSON.stringify(servers);
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
    console.log("✓ claude init 判据 + 经 ClaudeExecutor 的接线(参数位置、没连上出声、连上不出声)");
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
    const ready = new CodexAshMcpStatus();
    assert.equal(ready.update({ name: "kb", status: "failed" }), null, "别家的 MCP 不归这里说");
    assert.equal(ready.update({ name: "ash", status: "starting" }), null);
    assert.equal(ready.update({ name: "ash", status: "ready" }), null);
    assert.equal(ready.settle(), null, "ready ⇒ 收尾也不出声");

    const failed = new CodexAshMcpStatus();
    const told = failed.update({ name: "ash", status: "failed", error: "MCP client for `ash` timed out after 30 seconds." });
    assert.match((told as { message: string }).message, /启动失败：MCP client for `ash` timed out/, "带上 codex 的原话");
    assert.equal(failed.settle(), null, "说过了就不再说");

    assert.match((new CodexAshMcpStatus().settle() as { message: string }).message, /没有加载 ash MCP/);
    const stuck = new CodexAshMcpStatus();
    stuck.update({ name: "ash", status: "starting" });
    assert.match((stuck.settle() as { message: string }).message, /一直没启动完成/);
    console.log("✓ codex 启动状态:ready 不出声、failed 带原话、没加载 / 没启动完各一句、只说一次");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
