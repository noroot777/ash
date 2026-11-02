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
//   9. 候选目录是 orchestrator 可能选中目录的**超集**（形状 + 它凭什么是超集的不变量）
//  10. claude 项目级登记：超集里**任一**目录有登记就放行，全都没有才准拦
//  11. F3 两个输出通道分开；超集问不全（被截断）时不准拦；重复目录去重
//  12. F2 判据层与探测层都只准走启动计划层；判据层不准自己起进程（依赖方向）
//  13. B1 预检必须消费**运行时那份**有效执行上下文（空 id / 悬空 id 落默认 profile、
//      整段参数拆词），以及「宿主启动诊断仍是默认上下文」这条边界
//  14. B2 同类：诊断读 init 事件也按集合判，不取第一项
// 另：codex 探测原样带整份 extraArgs（紧贴写法 `-cKEY=VAL` 真实 CLI 认），
//     并用结构断言挡住「再挑一个子集」。
// 探测层（进程生命周期、输出解码）在 `test-ash-mcp-probe.ts`。
// 跑：npm -w server run test:ash-mcp-reach
//
// 第 8 条（CLI 不在）会在装了 codex 的机器上**明确跳过**：resolveBin 还扫
// `extraPaths()` 里 /opt/homebrew/bin 这类固定目录，环境变量隔离不掉（第 3 轮审查 N1）。
// 跳过时会打印原因 —— 宁可不跑，也不让它在不同安装布局上随机变红。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-mcp-reach-"));
process.env.ASH_DB = join(stage, "t.db");
process.env.HARNESS_DB = process.env.ASH_DB;

// **判存在性也必须走 resolveLaunch**：Windows 上 npm 装的 CLI 是 `.cmd` 垫片，直接
// `execFile` 起它拿到 EINVAL —— 那会让整批 CLI 用例在真机上被静默跳过，于是这份登记
// 根本不能算「真机预检通过」（第 2 位审查者在覆盖声明里点出的）。
const { resolveLaunch, extraPaths } = await import("../src/executors/bin-resolve.js");
const { cliSpec } = await import("../src/executors/catalog/index.js");
const has = (bin: string): boolean => !!resolveLaunch(bin, []);

/** 同理,**跑**一条真实 CLI 命令也得走启动计划层,不能 `execFileSync("claude", …)`。 */
const runCli = (bin: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv }): void => {
  const plan = resolveLaunch(bin, args);
  assert.ok(plan, `${bin} 必须解析出启动计划`);
  execFileSync(plan!.file, plan!.args, {
    ...opts, stdio: "ignore", timeout: 60_000,
    ...(plan!.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
};

async function checkCliReachability(): Promise<void> {
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
    // 命令行覆盖带来的 ash 要带上去问（codex 列得出它）—— 但它不在 $CODEX_HOME/config.toml 里，
    // 执行器注不进回合身份，跑完上报照样被拒（新链第 5 轮审查第 3 条），所以结论是「拦」，
    // 而且要说清是身份注不进去，不是「没有登记」。登记自己声明了 env_vars 才算交得了卷。
    const overridden = await reach({ executorId: "ex-codex-override" });
    assert.equal(overridden.reachable, false, "F1：-c 带来的 ash 注不进回合身份 → 拦");
    assert.match(overridden.problem ?? "", /注入回合身份/, "要说清卡在身份注入上");
    await db.insert(agents).values({
      id: "ex-codex-override-wired", name: "codex+override+env_vars", type: "codex",
      extraArgs: JSON.stringify(["-c", 'mcp_servers.ash.command="node"',
        "-c", 'mcp_servers.ash.env_vars=["ASH_TASK_ID","ASH_TURN_TOKEN","ASH_DIRECTION_TOKEN"]']),
    });
    assert.equal(
      (await reach({ executorId: "ex-codex-override-wired" })).reachable, true,
      "F1：覆盖里自己声明了 env_vars → 身份进得去，必须算数",
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
    // 用完即清:这些 profile 会成为 codex 的默认 profile(defaultProfile 没有 isDefault
    // 时回退 rows[0]),留着就会把后面「不带 executorId」的断言带偏 —— B1 修好之后,
    // 空 id 走的就是默认 profile 那条路。
    await db.delete(agents);
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
    runCli("claude", ["mcp", "add", "ash", "--scope", "user", "--", "node", "/tmp/x.js"],
      { env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir } });
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
    await db.delete(agents);                         // 同上:别让它成为后面用例的默认 profile
    delete process.env.CLAUDE_CONFIG_DIR;
  }

  // ── 10. F1:传了目录,项目级登记才看得见;不传就只剩用户级 ───────────────────
  if (has("claude")) {
    const userDir = join(stage, "claude-user-empty");
    const projectDir = join(stage, "task-workspace");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(userDir, ".claude.json"), "{}\n");
    process.env.CLAUDE_CONFIG_DIR = userDir;
    // 只在**这个项目目录**里登记（--scope local 落在 projects[cwd].mcpServers）
    runCli("claude", ["mcp", "add", "ash", "--scope", "local", "--", "node", "/tmp/x.js"],
      { cwd: projectDir, env: { ...process.env, CLAUDE_CONFIG_DIR: userDir } });
    const withDir = await ashMcpReachability({ agentType: "claude", cwdCandidates: [projectDir] });
    assert.equal(withDir.reachable, true, "F1：传了任务目录，项目级登记必须算数");
    const noDir = await ashMcpReachability({ agentType: "claude", cwdCandidates: [] });
    assert.equal(noDir.reachable, false, "没有目录时只剩用户级，这里确实没有 → 拦");
    // 不存在的目录不能被当成有效答案的来源（orchestrator 那边会重建，这里只负责别乱问）
    const ghost = await ashMcpReachability({
      agentType: "claude", cwdCandidates: [join(stage, "gone"), projectDir],
    });
    assert.equal(ghost.reachable, true, "候选里的失效目录要跳过，接着问下一个");

    // **本轮 F1 的形状**：超集里既有没登记的目录、也有有登记的,而「真实会跑哪一个」
    // 预检不知道(实测现场:诊断会话排最新、cwd 为 null,orchestrator 用的是旧会话那个
    // 目录)。所以判据不是「问对了那一个」,而是「任一有登记就放行」—— 顺序、诊断行过滤、
    // prev 怎么选,全都不再影响结论。两个方向都钉:命中要放行,全不命中才准拦。
    const bare = join(stage, "no-registration-here");
    mkdirSync(bare, { recursive: true });
    assert.equal(
      (await ashMcpReachability({ agentType: "claude", cwdCandidates: [bare, projectDir] })).reachable,
      true, "F1：超集里任一目录有登记就必须放行（哪怕排在后面）",
    );
    assert.equal(
      (await ashMcpReachability({ agentType: "claude", cwdCandidates: [bare] })).reachable,
      false, "反向:超集里全都没有登记,才是那个能拦人的确定结论",
    );
    delete process.env.CLAUDE_CONFIG_DIR;
  }

  // ── 11. F3:成功命令的 stderr 警告不能污染 stdout 的 JSON 答案 ──────────────
  // 用一个**假 codex**：退出 0、stdout 给完整 JSON、stderr 同时写一句警告。真 codex 那条
  // 警告要靠占住它内部某个缓存路径才能逼出来（版本一变就没了），拿假的来测「通道分离」
  // 这件事本身更确定 —— 拼接实现在这里必挂：JSON.parse("[]\nWARNING…") 抛错 → unknown
  // → 放行，而正确答案是「空列表 = 没有 ash」。
  //
  // 壳按平台写（第 2 位审查者 N1）：POSIX 下是 `codex` + `#!/bin/sh`，Windows 下必须是
  // `codex.cmd`（那边 resolveBin 的候选名不含裸名，`#!/bin/sh` 也起不来），干活的逻辑
  // 两边共用同一个 .mjs，PATH 也按 path.delimiter 拼 —— 否则这批用例在真机上静默跳过。
  {
    const fakeDir = join(stage, "fake-cli");
    mkdirSync(fakeDir, { recursive: true });
    const payload = join(fakeDir, "payload.json");
    const brain = join(fakeDir, "fake-codex.mjs");
    writeFileSync(brain,
      'import { readFileSync } from "node:fs";\n'
      + `process.stdout.write(readFileSync(${JSON.stringify(payload)}, "utf8"));\n`
      + 'process.stderr.write("WARNING: proceeding, even though we could not create PATH aliases:'
      + ' File exists (os error 17)\\n");\n');
    if (process.platform === "win32") {
      writeFileSync(join(fakeDir, "codex.cmd"), `@echo off\r\n"${process.execPath}" "${brain}" %*\r\n`);
    } else {
      const shim = join(fakeDir, "codex");
      writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${brain}" "$@"\n`);
      chmodSync(shim, 0o755);
    }
    const fake = (stdout: string) => writeFileSync(payload, stdout);
    const pathWas = process.env.PATH;
    process.env.PATH = `${fakeDir}${delimiter}${pathWas ?? ""}`;

    fake("[]");
    const empty = await ashMcpReachability({ agentType: "codex" });
    assert.equal(empty.reachable, false, "F3：stderr 有警告时，stdout 的空列表仍是有效答案 → 拦");

    fake('[{"name":"ash","enabled":false,"disabled_reason":"turned off"}]');
    const off = await ashMcpReachability({ agentType: "codex" });
    assert.equal(off.reachable, false, "F3：禁用的答案也不能被 stderr 冲掉");
    assert.match(off.problem ?? "", /turned off/, "要把 CLI 给的停用原因带出来");

    writeCodex('[mcp_servers.ash]\ncommand = "node"\n');
    fake('[{"name":"ash","enabled":true}]');
    const on = await ashMcpReachability({ agentType: "codex" });
    assert.equal(on.reachable, true, "F3：正常登记照样放行");

    // 证据面 = 生效面（新链第 5 轮审查第 3 条）：CLI 列得出的登记不在 $CODEX_HOME/config.toml 里
    // （受信任项目的 .codex/config.toml 合进来的那种），执行器注不进回合身份 → 交不了卷。
    writeCodex('model = "x"\n');
    const elsewhere = await ashMcpReachability({ agentType: "codex" });
    assert.equal(elsewhere.reachable, false, "CLI 列得出、注入那一侧看不见 → 拦");
    assert.match(elsewhere.problem ?? "", /注入回合身份/);
    fake('[{"name":"ash","enabled":true,"transport":{"type":"stdio","env_vars":["ASH_TASK_ID","ASH_TURN_TOKEN"]}}]');
    assert.equal((await ashMcpReachability({ agentType: "codex" })).reachable, true,
      "登记自己声明了把身份变量放进来 → 放行");
    writeCodex('[mcp_servers.harness]\ncommand = "node"\n');
    fake('[{"name":"harness","enabled":true},{"name":"ash","enabled":true}]');
    assert.equal((await ashMcpReachability({ agentType: "codex" })).reachable, true,
      "列出来的几条里有一条注得进去就够");

    // 超集太大时的收口:问不全就不准拦(拿假 CLI 测,每次 ~10ms,真 claude 要 800ms×2×N)。
    fake("[]");
    const many = Array.from({ length: 9 }, (_, i) => {
      const d = join(stage, `many-${i}`);
      mkdirSync(d, { recursive: true });
      return d;
    });
    assert.equal(
      (await ashMcpReachability({ agentType: "codex", cwdCandidates: many.slice(0, 8) })).reachable,
      false, "8 个目录问得全,全说没有 → 这是确定结论,拦",
    );
    // 目录多到问不全时,「CLI 都说没有」不再确定 → 交给配置文件那一档用全部目录再判一次
    // (新链第 3 轮第 2 条:上一版直接放行)。文件里有登记就放行,确定没有就拦、并注明证据来源。
    useCodexHome();
    writeCodex('[mcp_servers.ash]\ncommand = "node"\n');
    assert.equal(
      (await ashMcpReachability({ agentType: "codex", cwdCandidates: many })).reachable,
      true, "问不全 + 配置里有登记 → 放行",
    );
    writeCodex('model = "x"\n');
    const truncated = await ashMcpReachability({ agentType: "codex", cwdCandidates: many });
    assert.equal(truncated.reachable, false, "问不全 + 配置里确定没有 → 拦");
    // 慢机器(Windows 上每问一次假 CLI 要 1~2 秒)可能先撞上 20 秒总时限、问不到第 8 个 —— 那是
    // 同一个出口(退文件档、照样拦),只是没问全的原因不同。两种都认,撞时限时如实说一声。
    assert.match(truncated.problem ?? "", /读配置文件得出[\s\S]*(?:只问了前 8 个|时限用完)/, "文案写明证据来源和为什么没问全");
    if (/时限用完/.test(truncated.problem ?? "")) console.log("⚠ 这台机器 8 问没在时限内问完：截断那条退成了时限那条（同一个出口）");

    // CLI 给了答案、但看不懂(以及超时、被打断、预算用完,同一条路):同样先过配置文件那一档。
    fake("这不是 JSON");
    const garbled = await ashMcpReachability({ agentType: "codex" });
    assert.equal(garbled.reachable, false, "看不懂 + 配置里确定没有 → 拦，不再一律放行");
    assert.match(garbled.problem ?? "", /输出看不懂/);
    writeCodex('[mcp_servers.ash]\ncommand = "node"\n');
    assert.equal((await ashMcpReachability({ agentType: "codex" })).reachable, true,
      "看不懂 + 配置里有登记 → 放行");
    writeCodex('note = """\n[mcp_servers.ash]\n"""\n');
    assert.equal((await ashMcpReachability({ agentType: "codex" })).reachable, true,
      "看不懂 + 配置也判不了 → 两档都说不出来才放行");
    delete process.env.CODEX_HOME;
    fake("[]"); // 上面几条把假 CLI 换成了乱码，不换回来这条就走到宿主真实配置那一档
    assert.equal(
      (await ashMcpReachability({ agentType: "codex", cwdCandidates: Array(12).fill(many[0]!) })).reachable,
      false, "重复目录去重后没超上限 → 照常拦(一条任务的会话常常都在同一个目录)",
    );

    // ── B2:两个兼容名是**集合**,不是「取第一个」──────────────────────────
    // 真机实测过的形状:新名那份被关掉、旧名那份还连着,codex app-server 确实列出了
    // harness 的 report_stage,派审却因为第一份被禁用而整轮 409(第 3 轮审查 B2)。
    // 配置文件跟着 CLI 的说法写:注入那一侧读的就是它(上面 delete 过 CODEX_HOME,不设回来就读到宿主真实配置)。
    useCodexHome();
    writeCodex('[mcp_servers.ash]\ncommand = "node"\nenabled = false\n[mcp_servers.harness]\ncommand = "node"\n');
    fake('[{"name":"ash","enabled":false,"disabled_reason":"turned off"},{"name":"harness","enabled":true}]');
    assert.equal(
      (await ashMcpReachability({ agentType: "codex" })).reachable, true,
      "B2:新名那份被禁用,但旧名那份还启用 → 工具拿得到,必须放行",
    );
    fake('[{"name":"harness","enabled":true},{"name":"ash","enabled":false}]');
    assert.equal(
      (await ashMcpReachability({ agentType: "codex" })).reachable, true,
      "B2:换个顺序结论必须一样(说明判的是集合,不是第一项)",
    );
    fake('[{"name":"ash","enabled":false,"disabled_reason":"a"},{"name":"harness","enabled":false,"disabled_reason":"b"}]');
    const bothOff = await ashMcpReachability({ agentType: "codex" });
    assert.equal(bothOff.reachable, false, "B2:两份都禁用才是确定拿不到");
    assert.match(bothOff.problem ?? "", /ash/, "拦人时要说清是哪几份登记");
    assert.match(bothOff.problem ?? "", /harness/, "两份都要点名,否则用户只关掉一份还是跑不通");

    process.env.PATH = pathWas;
  }

  // ── 13. B1:预检必须消费**运行时那份**有效执行上下文 ─────────────────────
  // 第 3 轮审查用真实 HTTP 打穿的形状:接好的**默认**执行器(extraArgs 里带着
  // `-c mcp_servers.ash.command=node`)被预检判成没有登记,派审当场 409。病根是预检
  // 自己读 `agents.extraArgs`:空 id 和悬空 id 它都当「没有额外参数」,而运行时的
  // pickProfile 这两种都会落到该类型当前默认 profile;整段参数它也没拆词。
  if (!has("codex")) console.log("⚠ 跳过 B1 各条：这台机器上没有 codex CLI");
  else {
    const home = join(stage, "codex-b1");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.toml"), "");     // 配置里什么都没有
    process.env.CODEX_HOME = home;
    const { agents: agentsTable } = await import("../src/db/schema.js");
    const { eq: eqOp } = await import("drizzle-orm");

    assert.equal((await reach()).reachable, false, "基准:配置和参数里都没有 ash → 拦");
    // 每种写法都附带一条声明了身份变量的 `env_vars`:光有 `-c …command=node` 的登记注不进回合
    // 身份,本来就该拦(第 5 轮审查第 3 条,见上面 F1)。这里钉的是「参数有没有被带上去问」——
    // command 那条没被认出来时,codex 只看到一条缺 command 的登记、整份报错 → 退文件档 → 拦。
    const WIRED = ["-c", 'mcp_servers.ash.env_vars=["ASH_TURN_TOKEN"]'];

    // 唯一的 ash 来源是这条默认 profile 的 extraArgs(分词形态)
    await db.insert(agentsTable).values({
      id: "b1-default", name: "codex-default", type: "codex", isDefault: true,
      extraArgs: JSON.stringify(["-c", "mcp_servers.ash.command=node", ...WIRED]),
    });
    assert.equal(
      (await reach({ executorId: null })).reachable, true,
      "B1:空 executorId 必须跟运行时一样落到默认 profile",
    );
    assert.equal(
      (await reach({ executorId: "no-such-profile" })).reachable, true,
      "B1:悬空 id 同样降级到默认 profile,不是「没有额外参数」",
    );

    // 整段参数:库里是**一个元素**,运行时 normalizeProfileExtraArgs 会拆成两个 token
    await db.update(agentsTable).set({ extraArgs: JSON.stringify(["-c mcp_servers.ash.command=node", ...WIRED]) })
      .where(eqOp(agentsTable.id, "b1-default"));
    assert.equal(
      (await reach()).reachable, true,
      "B1:整段参数要按 normalizeProfileExtraArgs 拆词后再问",
    );

    // **紧贴写法**:真实 codex 吃 `-cKEY=VAL`(实测 rc=0 且列出 ash),上一版的子集筛选
    // 只认 `-c VALUE` / `--config VALUE` / 带等号那三种,把这条整个丢掉,于是探测问的是
    // 另一份配置,再拿那份的「没有」去拒真实执行器(第 4 轮审查 B1)。
    await db.update(agentsTable).set({ extraArgs: JSON.stringify(["-cmcp_servers.ash.command=node", ...WIRED]) })
      .where(eqOp(agentsTable.id, "b1-default"));
    assert.equal(
      (await reach()).reachable, true,
      "B1:紧贴写法 -cKEY=VAL 真实 codex 认,预检必须跟着认",
    );

    // 边界:宿主启动诊断问的是**默认上下文**,不能被任务默认 profile 带偏
    const { hostAshMcpGap } = await import("../src/ash-mcp-reachability.js");
    const gap = await hostAshMcpGap("codex");
    assert.ok(gap, "B1 边界:profile 里的 -c 覆盖不属于「这台机器默认配置」,启动诊断仍该报缺失");
    assert.equal(gap!.basis, "cli", "能问 CLI 的机器上,启动诊断的证据来源是 CLI 本人");

    await db.delete(agentsTable).where(eqOp(agentsTable.id, "b1-default"));
    delete process.env.CODEX_HOME;
  }

  // 探测层自己那几条（超时回收、包装先退出、正常退出也收尾、信号、跨块解码、
  // ConfineRead 三档语义）住在 test-ash-mcp-probe.ts —— 这个文件只管判据。

  // ── 8. CLI 压根不在 ───────────────────────────────────────────────────────
  // 「CLI 不在」这个**前提**得先成立：resolveBin 扫的是 PATH **加** `extraPaths()`，
  // 而后者在 POSIX 上有 `/opt/homebrew/bin`、`/usr/local/bin` 这种**固定**目录，在
  // Windows 上还看 USERPROFILE / APPDATA / LOCALAPPDATA —— 第 3 轮审查 N1 指出上一版
  // 只清 PATH+HOME，那台机器的 codex 就住在 `C:\Users\…\.local\bin`，照样解析得到，
  // 于是这条「应放行」的断言会在别的安装布局上随机变红。
  //
  // 所以：能隔离的环境变量全部指到空目录，然后**按同一份候选目录核对前提**；前提不
  // 成立就明确跳过并说明原因，而不是让断言去赌机器怎么装的。
  const emptyHome = join(stage, "empty-home");
  mkdirSync(emptyHome, { recursive: true });
  process.env.PATH = join(stage, "nothing-here");
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ChocolateyInstall"]) {
    process.env[key] = join(emptyHome, key.toLowerCase());
  }
  process.env.CODEX_HOME = join(emptyHome, ".codex");
  const stillThere = cliSpec("codex").bins.filter((b) => resolveLaunch(b, []));
  if (stillThere.length) {
    console.log(`⚠ 跳过「CLI 不在」一条：隔离后仍解析得到 ${stillThere.join("/")}`
      + `（${extraPaths().filter((d) => d.startsWith("/")).join("、")} 这类固定候选目录不受环境变量控制）`);
  } else {
    assert.equal((await reach()).reachable, true, "CLI 不在这台机器上 → 放行，不拦人");
  }
  Object.assign(process.env, {
    PATH: baseEnv.PATH, HOME: baseEnv.HOME, USERPROFILE: baseEnv.USERPROFILE,
    APPDATA: baseEnv.APPDATA, LOCALAPPDATA: baseEnv.LOCALAPPDATA,
  });

  console.log("✅ ash MCP 预检（真实 CLI 对照 F1/F2 全部形状）通过");
}

try {
  const { checkPortableReachability } = await import("./ash-mcp-reach-portable.js");
  await checkPortableReachability();
  const { confineAbstention } = await import("../src/executors/kernel-confine.js");
  const abstention = confineAbstention();
  if (abstention) {
    console.log(`⚠ 仅跳过需要启动 CLI 的预检用例：${abstention}`);
    console.log("  ⇒ 平台无关断言已执行；配置文件退路另由 test:ash-mcp-file 覆盖。");
  } else {
    await checkCliReachability();
  }
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
