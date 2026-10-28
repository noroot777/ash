// 派审前那道 ash MCP 预检（server/src/ash-mcp-reachability.ts）。
//
// 为什么非钉不可：这道门禁**会拦掉一整轮审查**，拦错一次用户得到的是一条根本跑不起来
// 的链。第 1 版靠读配置文件判，被第 1 轮审查用真实 CLI 打穿（F1/F2）——一份配置文件里
// 没有，不等于这一轮的 CLI 没有工具。所以这一版改成问 CLI 自己，而「问得对不对」只有
// 拿真实 CLI 跑才算数。
//
// 覆盖（每条都是 F1/F2 的实测反例，错了就是拦掉本来能跑的审查）：
//   1. 执行器不是 claude/codex → 放行
//   2. codex：配置在、里面确实没有 ash → 拦（这是 2026-10-28 现场那台机器的形状）
//   3. codex：有 ash → 放行
//   4. codex F2 四种 TOML 形状：引号名 / 表头带缩进 / **另一个** server 表头带行尾注释
//      且 enabled=false / ash 表头带行尾注释且 enabled=false —— 全交给 codex 自己判
//   5. codex F1：executor 的 `-c mcp_servers.…` 覆盖要被带上去问
//   6. claude F1：`CLAUDE_CONFIG_DIR` 指到哪就问哪
//   7. claude：带 `--mcp-config` 这类判不了的覆盖参数 → 放行
//   8. CLI 不在这台机器上 → 放行
// 跑：npm -w server run test:ash-mcp-reach
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stage = mkdtempSync(join(tmpdir(), "ash-mcp-reach-"));
process.env.ASH_DB = join(stage, "t.db");
process.env.HARNESS_DB = process.env.ASH_DB;

const has = (bin: string): boolean => {
  try { execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 20_000 }); return true; }
  catch { return false; }
};

try {
  const { ensureSchema } = await import("../src/db/index.js");
  await ensureSchema();
  const { db } = await import("../src/db/index.js");
  const { agents } = await import("../src/db/schema.js");
  const { ashMcpReachability } = await import("../src/ash-mcp-reachability.js");

  const codexHome = join(stage, "codex");
  mkdirSync(codexHome, { recursive: true });
  const writeCodex = (toml: string) => writeFileSync(join(codexHome, "config.toml"), toml);
  const baseEnv = { ...process.env };
  const useCodexHome = () => { process.env.CODEX_HOME = codexHome; };
  const reach = (over: Record<string, unknown> = {}) =>
    ashMcpReachability({ agentType: "codex", ...over } as Parameters<typeof ashMcpReachability>[0]);

  // ── 1. 不是 claude/codex ──────────────────────────────────────────────────
  assert.equal((await reach({ agentType: "grok" })).reachable, true, "别的执行器一律放行");

  const hasCodex = has("codex");
  if (!hasCodex) console.log("⚠ 跳过 codex 各条：这台机器上没有 codex CLI");
  else {
    useCodexHome();

    // ── 2. 配置在、确实没有 ash（现场那台机器的形状）────────────────────────
    writeCodex('model = "gpt-5.6-codex"\n[mcp_servers.node_repl]\ncommand = "node"\n');
    const absent = await reach();
    assert.equal(absent.reachable, false, "codex 配置里确实没有 ash → 必须拦");
    assert.match(absent.problem ?? "", /没有 ash MCP 登记/, "拦下来要说清是没有登记");

    // ── 3. 有 ash ─────────────────────────────────────────────────────────────
    writeCodex('[mcp_servers.ash]\ncommand = "node"\nargs = ["/tmp/x.js"]\n');
    assert.equal((await reach()).reachable, true, "有 ash → 放行");

    // ── 4. F2:四种 TOML 形状,正则全判错过,交给 codex 自己判 ─────────────────
    writeCodex('[mcp_servers."ash"]\ncommand = "node"\n');
    assert.equal((await reach()).reachable, true, 'F2 引号名 [mcp_servers."ash"] 不能当缺登记');

    writeCodex('  [mcp_servers.ash]\n  command = "node"\n');
    assert.equal((await reach()).reachable, true, "F2 表头带缩进不能当缺登记");

    // **别人**的表头带行尾注释:旧正则匹配不上那行、扫描停在 ash 表内,
    // 于是把 other 的 enabled=false 算到 ash 头上。
    writeCodex('[mcp_servers.ash]\ncommand = "node"\n[mcp_servers.other] # other server\ncommand = "node"\nenabled = false\n');
    assert.equal((await reach()).reachable, true, "F2 别人禁用不能算到 ash 头上");

    // 反向:ash 自己真被关了,表头带注释也得拦住。
    writeCodex('[mcp_servers.ash] # ash server\ncommand = "node"\nenabled = false\n');
    const off = await reach();
    assert.equal(off.reachable, false, "F2 ash 真被 enabled=false 关掉 → 必须拦");
    assert.match(off.problem ?? "", /没启用/, "拦下来要说清是没启用");

    // ── 5. F1:executor 的 `-c mcp_servers.…` 覆盖要带上去问 ────────────────
    writeCodex('model = "gpt-5.6-codex"\n');                       // 配置文件里一个 ash 都没有
    assert.equal((await reach()).reachable, false, "没有覆盖参数时仍该拦（基准）");
    await db.insert(agents).values({
      id: "ex-codex-override", name: "codex+override", type: "codex",
      extraArgs: JSON.stringify(["-c", 'mcp_servers.ash.command="node"']),
    });
    assert.equal(
      (await reach({ executorId: "ex-codex-override" })).reachable, true,
      "F1：命令行覆盖带来的 ash 必须算数",
    );
    // 无关的 `-c` 不该被带上去（带了也只是噪音，但判定不能因此翻转）
    await db.insert(agents).values({
      id: "ex-codex-unrelated", name: "codex+unrelated", type: "codex",
      extraArgs: JSON.stringify(["-c", 'model_reasoning_effort="high"']),
    });
    assert.equal(
      (await reach({ executorId: "ex-codex-unrelated" })).reachable, false,
      "无关的 -c 不该让判定翻转",
    );
    // extraArgs 坏掉 = 判不了 → 放行
    await db.insert(agents).values({
      id: "ex-codex-broken", name: "codex+broken", type: "codex", extraArgs: "{不是数组}",
    });
    assert.equal(
      (await reach({ executorId: "ex-codex-broken" })).reachable, true,
      "profile 的 extraArgs 读不出来 → 放行",
    );
  }

  // ── 6/7. claude ───────────────────────────────────────────────────────────
  if (!has("claude")) console.log("⚠ 跳过 claude 各条：这台机器上没有 claude CLI");
  else {
    const claudeDir = join(stage, "claude-cfg");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, ".claude.json"), "{}\n");
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    const asClaude = (over: Record<string, unknown> = {}) =>
      ashMcpReachability({ agentType: "claude", ...over } as Parameters<typeof ashMcpReachability>[0]);

    const none = await asClaude();
    assert.equal(none.reachable, false, "CLAUDE_CONFIG_DIR 里没有 ash → 拦");

    // F1.1：登记写进**这个**目录，预检就该看见它（旧版写死 homedir()，这条必挂）
    execFileSync("claude", ["mcp", "add", "ash", "--scope", "user", "--", "node", "/tmp/x.js"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir }, stdio: "ignore", timeout: 60_000,
    });
    assert.equal((await asClaude()).reachable, true, "F1：CLAUDE_CONFIG_DIR 里的登记必须算数");

    // 7. 判不了的覆盖参数 → 放行
    writeFileSync(join(claudeDir, ".claude.json"), "{}\n");
    assert.equal((await asClaude()).reachable, false, "清空后回到拦（基准）");
    await db.insert(agents).values({
      id: "ex-claude-mcpcfg", name: "claude+mcpconfig", type: "claude",
      extraArgs: JSON.stringify(["--mcp-config", "/tmp/extra.json"]),
    });
    assert.equal(
      (await asClaude({ executorId: "ex-claude-mcpcfg" })).reachable, true,
      "带 --mcp-config 时判不了 → 放行",
    );
    delete process.env.CLAUDE_CONFIG_DIR;
  }

  // ── 8. CLI 压根不在 ───────────────────────────────────────────────────────
  // PATH 清空 + 把候选目录指到一个空 home，resolveBin 一个都找不到。
  const emptyHome = join(stage, "empty-home");
  mkdirSync(emptyHome, { recursive: true });
  process.env.PATH = join(stage, "nothing-here");
  process.env.HOME = emptyHome;
  process.env.CODEX_HOME = join(emptyHome, ".codex");
  assert.equal((await reach()).reachable, true, "CLI 不在这台机器上 → 放行，不拦人");
  Object.assign(process.env, { PATH: baseEnv.PATH, HOME: baseEnv.HOME });

  console.log("✅ ash MCP 预检（真实 CLI 对照 F1/F2 全部形状）通过");
} finally {
  rmSync(stage, { recursive: true, force: true });
}
