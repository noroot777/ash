// 个人 CLI 配置目录里的 ash MCP 登记(`auth/user-cli-mcp.ts`)的回归测试。
//
// 钉的是「隔离档下 agent 交得了卷」这条命脉:2026-09-01 现场,一个把活干完、代码也
// 提交了的任务,最后一步 `mcp__ash__complete_task` 撞回 "No such tool available",
// 按完成协议记 failed —— 因为 `CLAUDE_CONFIG_DIR` 整个取代了 `~/.claude`,而装 ash 时
// 那条 `claude mcp add` 写的是宿主机那份。
//
// 全程用**假 HOME**:宿主机真实的 `~/.claude.json` / `~/.codex/config.toml` 是用户的
// 配置,一个字节都不许动;用真 HOME 跑的话,「补对了」和「它偷偷读写了宿主」看起来
// 一模一样。
//
// 跑法:npm -w server run test:user-cli-mcp
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import type { ProbeOutcome } from "../src/ash-mcp-probe.js";
import { ensureAshMcp, extractTomlTables, hostAshMcp, readAshMcp, type CodexAsk } from "../src/auth/user-cli-mcp.js";
import { resolveLaunch } from "../src/executors/bin-resolve.js";
import { REPO_DIR } from "../src/paths.js";
import { releaseTmpDb, requireTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-user-cli-mcp-"));
process.on("exit", () => rmSync(stage, { recursive: true, force: true }));

/** 每一格都拿一副全新的「假 HOME + 个人目录」,免得前一格的写入影响后一格。 */
let seq = 0;
function bench(hostFiles: { claude?: string; codex?: string } = {}) {
  const root = join(stage, `case-${++seq}`);
  const host = join(root, "home");
  const dir = join(root, "user-cli");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(host, ".codex"), { recursive: true });
  if (hostFiles.claude !== undefined) writeFileSync(join(host, ".claude.json"), hostFiles.claude, "utf8");
  if (hostFiles.codex !== undefined) writeFileSync(join(host, ".codex", "config.toml"), hostFiles.codex, "utf8");
  return { host, dir };
}

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;

// ── 「问 codex 本人」那一问的替身 ──────────────────────────────────────────
//
// 产品代码把这一问交给探测执行层(`probeCli`:异步、起之前先拿到内核圈定的归属、每条结束
// 路径都收得回来)。**macOS 上那一层如实弃权**,于是产品在开发机上一律答「没问过 ⇒ 不补接」
// —— 这几格要钉的却是「问出不同答案时各自怎么收场」,所以这里换替身把那几条路逐个驱动起来
// (口子和理由同 `probeCli` 的 `openUnit`:生产代码里没有任何弱归属实现)。

/** codex 收下了。多数格子钉的是**写出来的内容**,不是 codex 的判决,用这个。 */
const LISTS_ASH: ProbeOutcome = {
  kind: "answer", code: 0, stdout: JSON.stringify([{ name: "ash", enabled: true }]), stderr: "",
};

/** 按固定答案应付,并把「它拿什么去问的、问的时候用户那份文件长什么样」记下来。 */
type Asked = { sandbox: string; candidate: string; userFile: string | null };
function canned(outcome: ProbeOutcome, log?: Asked[], userFile?: string): CodexAsk {
  return async (sandbox) => {
    log?.push({
      sandbox,
      candidate: readFileSync(join(sandbox, "config.toml"), "utf8"),
      userFile: userFile && existsSync(userFile) ? readFileSync(userFile, "utf8") : null,
    });
    return outcome;
  };
}

/**
 * **真的去问 codex 本人**(拿沙盘里那份候选)。没装 codex 就如实答「没启动」。
 *
 * 测试进程里自己 spawn 是允许的:它堵不到 server 的事件循环,进程也随测试一起走 ——
 * 产品代码里不许这么写(本轮审查 F2),那条断言在最后一格。
 */
const askRealCodex: CodexAsk = async (sandbox) => {
  const plan = resolveLaunch("codex", ["mcp", "list", "--json"]);
  if (!plan) return { kind: "not-started", why: "这台机器上没装 codex" };
  const res = spawnSync(plan.file, plan.args, {
    cwd: sandbox,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, CODEX_HOME: sandbox },
    ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true as const } : {}),
  });
  if (res.error || res.signal || res.status === null) return { kind: "unqueryable" };
  return { kind: "answer", code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

const HAS_CODEX = !!resolveLaunch("codex", ["mcp", "list", "--json"]);

/** 默认替身 = 「codex 收下了」。只有明确要考 codex 判决的格子才自己传。 */
const ensure = (dir: string, agent: string, host: string, ask: CodexAsk = canned(LISTS_ASH)) =>
  ensureAshMcp(dir, agent, host, ask);
/** 宿主真的没登记过、仓库也没 build 过 mcp 时,唯一诚实的答案是「补不上」。 */
const HAS_BUILT_MCP = existsSync(join(REPO_DIR, "mcp", "dist", "index.js"));

const HOST_CLAUDE = JSON.stringify({
  mcpServers: {
    ash: { type: "stdio", command: "node", args: ["/opt/ash/mcp/dist/index.js"], env: { ASH_URL: "http://localhost:4317" } },
    kb: { type: "stdio", command: "uv", args: ["run", "kb-mcp"], env: {} },
  },
});

// ① 宿主那条搬过来,个人目录里原有的东西一个不动。
{
  const { host, dir } = bench({ claude: HOST_CLAUDE });
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: {} }), "utf8");
  const state = await ensure(dir, "claude", host);
  assert.equal(state.configured, true);
  assert.equal(state.serverName, ASH_MCP_SERVER_NAME);
  const doc = readJson(join(dir, ".claude.json"));
  assert.equal(doc.hasCompletedOnboarding, true, "seed 里原有的键不能被冲掉");
  assert.deepEqual(doc.mcpServers.ash.args, ["/opt/ash/mcp/dist/index.js"], "定义要照搬宿主那条");
  assert.ok(!doc.mcpServers.kb, "只搬 ash 这一条,宿主的第三方 server 不许跟着过来");
}

// ② 个人目录里还没有 .claude.json 时也能补(文件由这一步建出来)。
{
  const { host, dir } = bench({ claude: HOST_CLAUDE });
  assert.equal((await ensure(dir, "claude", host)).configured, true);
  assert.ok(readJson(join(dir, ".claude.json")).mcpServers.ash, "该建的文件要建出来");
}

// ③ 幂等:第二次调用一个字节都不该改(CLI 可能正在写这份文件)。
{
  const { host, dir } = bench({ claude: HOST_CLAUDE });
  await ensure(dir, "claude", host);
  const first = readFileSync(join(dir, ".claude.json"), "utf8");
  const again = await ensure(dir, "claude", host);
  assert.equal(again.configured, true);
  assert.equal(readFileSync(join(dir, ".claude.json"), "utf8"), first, "已经有了就不该再写");
}

// ④ 已有登记不覆盖 —— 包括历史名 harness(用户可能自己改过 URL / 路径)。
{
  const { host, dir } = bench({ claude: HOST_CLAUDE });
  const mine = { type: "stdio", command: "node", args: ["/我改过的/index.js"], env: {} };
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ mcpServers: { harness: mine } }), "utf8");
  const state = await ensure(dir, "claude", host);
  assert.equal(state.serverName, LEGACY_ASH_MCP_SERVER_NAME, "历史名也算已登记");
  const doc = readJson(join(dir, ".claude.json"));
  assert.deepEqual(doc.mcpServers.harness, mine, "用户改过的定义不许动");
  assert.ok(!doc.mcpServers.ash, "已有登记时不该再塞一条");
}

// ⑤ 个人 .claude.json 坏了:如实报错,**绝不覆盖**(那是用户的文件,里面还有会话记录)。
{
  const { host, dir } = bench({ claude: HOST_CLAUDE });
  const broken = "{ 这不是 JSON";
  writeFileSync(join(dir, ".claude.json"), broken, "utf8");
  const state = await ensure(dir, "claude", host);
  assert.equal(state.configured, false);
  assert.ok(state.problem && state.problem.includes(".claude.json"), "得说清楚是哪份文件");
  assert.equal(readFileSync(join(dir, ".claude.json"), "utf8"), broken, "坏文件也不许被覆盖");
}

// ⑥ 宿主也没有:没 build 过 mcp 就诚实说补不上,build 过就按仓库这份现拼一条。
{
  const { host, dir } = bench();
  const state = await ensure(dir, "claude", host);
  assert.equal(state.configured, HAS_BUILT_MCP);
  if (HAS_BUILT_MCP) {
    assert.deepEqual(readJson(join(dir, ".claude.json")).mcpServers.ash.args, [join(REPO_DIR, "mcp", "dist", "index.js")]);
  } else {
    assert.ok(state.problem?.includes("mcp"), "补不上时要指出缺的是什么");
  }
}

// ⑦ 宿主的 .claude.json 从头到尾不许被写(它是用户的真配置)。
{
  const { host, dir } = bench({ claude: HOST_CLAUDE });
  await ensure(dir, "claude", host);
  assert.equal(readFileSync(join(host, ".claude.json"), "utf8"), HOST_CLAUDE, "宿主配置只读");
}

// ⑧ codex:整段 [mcp_servers.ash] 连子表一起搬,后面无关的表不许跟着过来。
{
  const hostToml =
    `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/ash/mcp/dist/index.js"]\n\n` +
    `[mcp_servers.ash.env]\nASH_URL = "http://localhost:4317"\n\n` +
    `[projects."/opt/ash"]\ntrust_level = "trusted"\n`;
  const { host, dir } = bench({ codex: hostToml });
  const state = await ensure(dir, "codex", host);
  assert.equal(state.configured, true);
  const written = readFileSync(join(dir, "config.toml"), "utf8");
  assert.ok(written.includes("[mcp_servers.ash]"), "主表要在");
  assert.ok(written.includes("[mcp_servers.ash.env]"), "子表也要跟着搬");
  assert.ok(!written.includes("projects"), "后面那张无关的表不许被带走");
  // 执行器认不认,以它自己那份判据为准。
  const { codexAshMcpServerName } = await import("../src/executors/codex-mcp.js");
  assert.equal(codexAshMcpServerName(dir), ASH_MCP_SERVER_NAME, "执行器必须认得出这条登记");
}

// ⑨ codex 历史名:定义照搬,表头改成规范名。
{
  const { host, dir } = bench({ codex: `[mcp_servers.harness]\ncommand = "node"\nargs = ["/old/index.js"]\n` });
  assert.equal((await ensure(dir, "codex", host)).configured, true);
  const written = readFileSync(join(dir, "config.toml"), "utf8");
  assert.ok(written.includes("[mcp_servers.ash]"), "表头要落成规范名");
  assert.ok(written.includes("/old/index.js"), "定义本身照搬");
}

// ⑩ codex 已有 config.toml:追加而不是重写(里面还有用户自己的设置)。
{
  const { host, dir } = bench({ codex: `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n` });
  writeFileSync(join(dir, "config.toml"), `model = "gpt-5.6"\n`, "utf8");
  await ensure(dir, "codex", host);
  const written = readFileSync(join(dir, "config.toml"), "utf8");
  assert.ok(written.includes(`model = "gpt-5.6"`), "用户原有设置必须留着");
  assert.ok(written.includes("[mcp_servers.ash]"), "登记要追加进去");
}

// ⑪ 表头切段的边界:数组表 [[...]] 也算一次切换。
{
  const config = `[mcp_servers.ash]\ncommand = "node"\n\n[[hooks]]\nrun = "x"\n`;
  const block = extractTomlTables(config, ASH_MCP_SERVER_NAME);
  assert.ok(block?.includes(`command = "node"`));
  assert.ok(!block?.includes("hooks"), "数组表不许被吞进来");
}

// ⑪b 切段和扫描器用同一份表头识别(新链第 4 轮审查:上一版要求表头独占整行、不认引号)。
{
  const quoted = `[mcp_servers."ash"]\ncommand = "node"\nargs = ["/h.js"]\n\n[mcp_servers."ash".env]\nASH_URL = "u"\n`;
  assert.equal(
    extractTomlTables(quoted, ASH_MCP_SERVER_NAME),
    `[mcp_servers.ash]\ncommand = "node"\nargs = ["/h.js"]\n\n[mcp_servers.ash.env]\nASH_URL = "u"`,
    "带引号的表头照样抠得出来,表头改写成规范拼法",
  );
  const commented = `[mcp_servers.ash]\ncommand = "node"\n[mcp_servers.secret] # 别人的\ncommand = "s"\ntoken = "t"\n`;
  const block = extractTomlTables(commented, ASH_MCP_SERVER_NAME);
  assert.ok(block && !block.includes("secret") && !block.includes("token"),
    "表头带行尾注释也算一次切换,别人的配置不许被抄进来");
  assert.equal(
    extractTomlTables(`[mcp_servers.'harness']\ncommand = "node"\n`, LEGACY_ASH_MCP_SERVER_NAME, ASH_MCP_SERVER_NAME),
    `[mcp_servers.ash]\ncommand = "node"`, "历史名(带引号)顺手改成规范名",
  );
  assert.equal(
    extractTomlTables(`[mcp_servers]\nash.command = "node"\n[mcp_servers.ash.env]\nASH_URL = "u"\n`, ASH_MCP_SERVER_NAME),
    null, "只抠得到 .env 那段 = 造出一条没有 command 的登记,宁可用内置模板",
  );
  assert.equal(
    extractTomlTables(`note = """\n[mcp_servers.ash]\ncommand = "x"\n"""\n`, ASH_MCP_SERVER_NAME),
    null, "多行字符串里的假表头不切段",
  );
  // 端到端:宿主是带引号的写法,隔离档要搬的是**宿主那份**,不是内置模板。
  const { host, dir } = bench({ codex: quoted });
  await ensure(dir, "codex", host);
  const written = readFileSync(join(dir, "config.toml"), "utf8");
  assert.ok(written.includes(`args = ["/h.js"]`) && written.includes(`ASH_URL = "u"`), "照搬宿主那份");
}

// ⑫ 只读版**一个字都不许写** —— 共用档拿它去问宿主机那份配置,那是用户自己的文件。
{
  const { dir } = bench();
  const state = readAshMcp(dir, "claude");
  assert.equal(state.configured, false, "空目录里当然没有登记");
  assert.ok(!existsSync(join(dir, ".claude.json")), "只读版不许把文件建出来");
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ mcpServers: { ash: {} } }), "utf8");
  assert.equal(readAshMcp(dir, "claude").serverName, ASH_MCP_SERVER_NAME);
}

// ⑬ 宿主视角的路径差一层:claude 读 ~/.claude.json,codex 读 ~/.codex/config.toml。
{
  const { host } = bench({ claude: HOST_CLAUDE, codex: `[mcp_servers.ash]\ncommand = "node"\n` });
  assert.equal(hostAshMcp("claude", host).configured, true, "claude 的用户级配置在 home 根");
  assert.equal(hostAshMcp("codex", host).configured, true, "codex 的在 ~/.codex/ 里");
  const bare = bench();
  assert.equal(hostAshMcp("claude", bare.host).configured, false);
  assert.equal(hostAshMcp("codex", bare.host).configured, false);
  // 问完之后宿主那边不该多出任何东西(只读的判据就是这个)。
  assert.ok(!existsSync(join(bare.host, ".claude.json")), "问一句不许把宿主配置建出来");
  assert.ok(!existsSync(join(bare.host, ".codex", "config.toml")), "codex 侧同理");
}

// ⑭ **档位是运行中能切的**:从「共用宿主机 CLI」切回隔离档那一下,就地补一遍。
// 不能只靠启动自检 —— 切完到下次重启之间起跑的任务全都用个人目录,缺登记就全记 failed。
{
  process.env.ASH_DB ||= join(stage, "switch.db");
  requireTmpDb("test-user-cli-mcp");
  const { ensureSchema } = await import("../src/db/index.js");
  const mode = await import("../src/auth/mode.js");
  const store = await import("../src/auth/store.js");
  const personal = await import("../src/auth/personal-settings.js");
  const { USER_CLI_ROOT, userCliDir } = await import("../src/auth/user-cli.js");
  await ensureSchema();

  const root = join(stage, "root");
  mkdirSync(root, { recursive: true });
  // 先落在**共用档**:那一档不注入个人配置目录,所以它们本来就可能一直是空的。
  await mode.setInstanceMode("multi", root, true);
  const admin = await store.createUser({ name: "切档管理员", dirName: "switcher", role: "admin" });
  process.on("exit", () => rmSync(join(USER_CLI_ROOT, admin.id), { recursive: true, force: true }));
  const claudeDir = userCliDir(admin.id, "claude");
  rmSync(claudeDir, { recursive: true, force: true });
  assert.ok(!existsSync(claudeDir), "共用档下这个目录可以是不存在的");

  await personal.patchSettingsFor(
    { kind: "user", userId: admin.id, role: "admin", name: admin.name },
    { sharedHostCli: false },
  );
  assert.ok(existsSync(claudeDir), "切到隔离档就该把个人配置目录建出来");
  // 这台机器上但凡有一处能取到定义(宿主装过 ash、或仓库 build 过 mcp),就必须补上。
  const { hostAshMcp: hostCheck } = await import("../src/auth/user-cli-mcp.js");
  if (hostCheck("claude").configured || HAS_BUILT_MCP) {
    assert.equal(readAshMcp(claudeDir, "claude").configured, true, "切档那一下必须把 ash MCP 补上");
  }
}

// ⑮ 写那一侧跟读那一侧问同一个扫描器（新链第 2 轮审查第 5 条）：引号表头、缩进表头都算
//    「已经有了」，关着的、看不准的不碰 —— 上一版用行首严格正则，判成没有就再 append 一份，
//    同名表重复，codex 整份配置读不出来。
{
  const HOST = `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n`;
  for (const existing of [
    `[mcp_servers."ash"]\ncommand = "node"\n`,
    `  [mcp_servers.ash]\ncommand = "node"\n`,
    `[mcp_servers]\nash = { command = "node" }\n`,
  ]) {
    const { host, dir } = bench({ codex: HOST });
    writeFileSync(join(dir, "config.toml"), existing, "utf8");
    const state = await ensure(dir, "codex", host);
    assert.equal(state.configured, true, `已有登记要认得出：${JSON.stringify(existing)}`);
    assert.equal(readFileSync(join(dir, "config.toml"), "utf8"), existing, "认出来了就一个字都不写");
  }
  {
    const { host, dir } = bench({ codex: HOST });
    const off = `[mcp_servers.ash]\ncommand = "node"\nenabled = false\n`;
    writeFileSync(join(dir, "config.toml"), off, "utf8");
    const state = await ensure(dir, "codex", host);
    assert.equal(state.configured, false, "关着的登记不算接好");
    assert.match(state.problem ?? "", /enabled = false/);
    assert.equal(readFileSync(join(dir, "config.toml"), "utf8"), off, "关着的不替用户打开，也不再追加一份");
  }
  {
    const { host, dir } = bench({ codex: HOST });
    // 多行字符串里的假表头：扫描器自己判不了（doubt），宁可不写。
    const odd = `notes = """\n[mcp_servers.ash]\n"""\n`;
    writeFileSync(join(dir, "config.toml"), odd, "utf8");
    const state = await ensure(dir, "codex", host);
    assert.equal(state.configured, false, "看不准就不说接好了");
    assert.match(state.problem ?? "", /看不准/);
    assert.equal(readFileSync(join(dir, "config.toml"), "utf8"), odd, "看不准时不追加");
  }
}

// ⑰ 个人配置**读不动**(权限、IO、被换成了目录)不是「空的」:一个字都不写,如实报出来。
//    上一版 claude 那半边把读失败吞成空文档,随即用一份只剩 MCP 登记的新文件整个盖掉,
//    还报「已接好」(新链第 5 轮审查第 1 条)。用同名目录造「读不动」:chmod 在 Windows 和 root 下不生效。
for (const agent of ["claude", "codex"] as const) {
  const { host, dir } = bench({ claude: HOST_CLAUDE, codex: `[mcp_servers.ash]\ncommand = "node"\n` });
  const file = join(dir, agent === "claude" ? ".claude.json" : "config.toml");
  mkdirSync(file);
  writeFileSync(join(file, "keep"), "x", "utf8");
  const state = await ensure(dir, agent, host);
  assert.equal(state.configured, false, `${agent}:读不动不能报「已接好」`);
  assert.match(state.problem ?? "", /读不出来/, `${agent}:要说清是读不出来`);
  assert.equal(readFileSync(join(file, "keep"), "utf8"), "x", `${agent}:读不动的东西原样留着`);
}

// ⑱ **先批准再发布：验不过的那次，用户那份配置一个字节都没被动过**（本轮审查 F1）。
//    上一版是「写进去 → 读回来 → 验不过再还原」：写完到还原之间崩一次，坏文件就留在那儿了，
//    而还原本身又是第二次写，会把别人同时存下的设置一起盖掉。现在顺序倒过来，没有还原这一步。
{
  // 宿主那条是**关着的**:搬过来照样是关着的,那不叫接好(agent 照样交不了卷)。
  const { host, dir } = bench({ codex: `[mcp_servers.ash]\ncommand = "node"\nenabled = false\n` });
  const before = `model = "gpt"\n`;
  const file = join(dir, "config.toml");
  writeFileSync(file, before, "utf8");
  const past = new Date("2020-01-01T00:00:00Z");
  utimesSync(file, past, past);
  const state = await ensure(dir, "codex", host);
  assert.equal(state.configured, false, "补上那段也读不出启用着的登记,不许报「已接好」");
  assert.equal(readFileSync(file, "utf8"), before, "原文照旧");
  assert.equal(statSync(file).mtimeMs, past.getTime(), "没批准就根本没写过 —— 连 mtime 都不该变");

  // 原来压根没有这个文件:也不许被建出来(上一版是先建、再删)。
  const second = bench({ codex: `[mcp_servers.ash]\ncommand = "node"\nenabled = false\n` });
  assert.equal((await ensure(second.dir, "codex", second.host)).configured, false);
  assert.equal(existsSync(join(second.dir, "config.toml")), false, "原来没有的文件不许被建出来");

  // 对照:宿主那条是开着的、codex 也收下了 → 落盘,如实报已接好。
  const third = bench({ codex: `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n` });
  writeFileSync(join(third.dir, "config.toml"), before, "utf8");
  assert.equal((await ensure(third.dir, "codex", third.host)).configured, true, "开着的照样补得上");
  assert.match(readFileSync(join(third.dir, "config.toml"), "utf8"), /\[mcp_servers\.ash\]/);
}

// ⑲ **整张 mcp_servers 写成内联值时一个字都不许写**（第 2 轮审查 F1）：我们唯一会写的东西
//    是追加一段 `[mcp_servers.ash]`，而 TOML 不许用表头扩展一个已经定义成内联值的表 ——
//    真机实测 codex 报 `cannot extend value of type inline table with a dotted key` 并整份
//    拒载，用户别的 MCP 一起加载不了。认得出登记的那一半同样重要：根内联里有 ash 就别写。
{
  const HOST = `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n`;
  // ① 根内联里确实没有 ash：缺是真的，但这份文件不能这么补 —— 如实报，并说清两种改法。
  const noAsh = `mcp_servers = { kb = { command = "node" } }\n`;
  {
    const { host, dir } = bench({ codex: HOST });
    const file = join(dir, "config.toml");
    writeFileSync(file, noAsh, "utf8");
    const state = await ensure(dir, "codex", host);
    assert.equal(state.configured, false, "补不了就不许报「已接好」");
    assert.match(state.problem ?? "", /内联/, "要说清是内联表挡住了");
    assert.match(state.problem ?? "", /普通表写法|自己加一条/, "要给得出改法");
    assert.equal(readFileSync(file, "utf8"), noAsh, "一个字都不许写 —— 写了就是整份拒载");
  }
  // ② 根内联里已经有 ash（codex 认得、`-c` 也落得上去）：认出来，更不该追加。
  for (const existing of [
    `mcp_servers = { ash = { command = "node" } }\n`,
    `mcp_servers = { "\\u0061sh" = { command = "node" } }\n`,
  ]) {
    const { host, dir } = bench({ codex: HOST });
    const file = join(dir, "config.toml");
    writeFileSync(file, existing, "utf8");
    const state = await ensure(dir, "codex", host);
    assert.equal(state.configured, true, `根内联登记要认得出：${JSON.stringify(existing)}`);
    assert.equal(readFileSync(file, "utf8"), existing, "认出来了就一个字都不写");
  }
}

// ⑳ **判官是 codex 本人,而且问的是沙盘里的副本**（本轮审查 F1）：我们那份是**结构**扫描器，
//    看得出新表头落进了文件里，证不了它在这份 TOML 上合法。这里拿一种真实形状把差别摆出来 ——
//    宿主那条登记的 env 值里有个不合法转义（`"http://bad\q"`），拼完扫描器照样答「ash 在、
//    启用着」，而真 codex 整份拒载（实测 rc=1 `missing escaped value`）。要的行为是：**一个
//    字节都不写**、如实报、给得出手工办法，而且同一份组合不再问第二遍（设置页每读一次、每条
//    任务起跑都会走到这里，不该为同一个已知答案反复起进程）。
{
  const BAD_HOST = `[mcp_servers.ash]\ncommand = "node"\nargs = ["/x.js"]\n\n`
    + `[mcp_servers.ash.env]\nASH_URL = "http://bad\\q"\n`;
  const { host, dir } = bench({ codex: BAD_HOST });
  const file = join(dir, "config.toml");
  const before = `model = "gpt"\n`;
  writeFileSync(file, before, "utf8");
  const past = new Date("2020-01-01T00:00:00Z");
  utimesSync(file, past, past);
  const state = await ensure(dir, "codex", host, askRealCodex);
  if (HAS_CODEX) {
    assert.equal(state.configured, false, "codex 读不动这份候选 ⇒ 不许报「已接好」");
    assert.match(state.problem ?? "", /codex 读不动|仍然没列出|关着的/, `要说清是 codex 那边的结论：${state.problem}`);
    assert.equal(readFileSync(file, "utf8"), before, "没批准 ⇒ 没写");
    assert.equal(statSync(file).mtimeMs, past.getTime(), "连 mtime 都不该变");
    assert.match(state.problem ?? "", /手工/, "补不上就得给办法");
    const again = await ensure(dir, "codex", host, async () => {
      throw new Error("同一份组合不该再问 codex 第二遍");
    });
    assert.equal(again.configured, false, "失败过的组合照样报失败");
    assert.equal(statSync(file).mtimeMs, past.getTime(), "第二次也一个字节都不该动");
  } else {
    console.log("⚠ 没装 codex，跳过「真 codex 判决」那一条");
    assert.equal(state.configured, false, "问不动 codex ⇒ 不补接（不拿「问不出来」当批准）");
  }
}

// ㉑ **「问不出来」不等于「可以发布」**（本轮审查 F1 的本体）：上一版把超时、起不来、输出
//    看不懂都当成「可以留着」—— 真机实测那正是「界面报已接好、下次启动 codex 整份拒载」的
//    那一格。四种答不出来的收场在这里一次过齐，判据只有一条：**没批准就没写**。
{
  const HOST = `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n`;
  const cases: { why: string; outcome: ProbeOutcome; expect: RegExp }[] = [
    { why: "起不来(macOS 上探测层弃权就是这一档)", outcome: { kind: "not-started", why: "内核圈定在这台机器上弃权" }, expect: /没法安全地起一次 codex/ },
    { why: "超时/被打断", outcome: { kind: "unqueryable" }, expect: /没给出一份能用的答案/ },
    { why: "退出码 0 但输出不是 JSON", outcome: { kind: "answer", code: 0, stdout: "Listing MCP servers…", stderr: "" }, expect: /输出看不懂/ },
    { why: "退出码 0、是列表但没列出 ash", outcome: { kind: "answer", code: 0, stdout: "[]", stderr: "" }, expect: /仍然没列出/ },
  ];
  for (const { why, outcome, expect } of cases) {
    const { host, dir } = bench({ codex: HOST });
    const file = join(dir, "config.toml");
    const before = `model = "gpt"\n`;
    writeFileSync(file, before, "utf8");
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(file, past, past);
    const state = await ensure(dir, "codex", host, canned(outcome));
    assert.equal(state.configured, false, `${why}:不许报「已接好」`);
    assert.match(state.problem ?? "", expect, `${why}:要说清为什么没接上 —— ${state.problem}`);
    assert.match(state.problem ?? "", /手工/, `${why}:补不上就得给办法`);
    assert.ok(state.problem?.includes("[mcp_servers.ash]"), `${why}:办法里要带上那段内容`);
    assert.equal(readFileSync(file, "utf8"), before, `${why}:用户那份配置一个字节都不许动`);
    assert.equal(statSync(file).mtimeMs, past.getTime(), `${why}:连 mtime 都不该变`);
  }
}

// ㉒ **问的是沙盘里的一份副本,不是用户那个文件**（本轮审查 F1）：批准之前用户那份配置必须
//    还是原样 —— 上一版正是「先写进去再问」，问的那十秒里盘上躺着的是一份 codex 整份拒载的
//    配置，中间崩一次就留在那儿了。
{
  const HOST = `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n`;
  const { host, dir } = bench({ codex: HOST });
  const file = join(dir, "config.toml");
  const before = `model = "gpt"\n`;
  writeFileSync(file, before, "utf8");
  const log: Asked[] = [];
  const state = await ensure(dir, "codex", host, canned(LISTS_ASH, log, file));
  assert.equal(state.configured, true);
  assert.equal(log.length, 1, "一次补接只问一遍");
  assert.notEqual(log[0]!.sandbox, dir, "问的得是另一个目录,不是用户的配置目录");
  assert.equal(log[0]!.userFile, before, "问的时候用户那份配置还是原样");
  assert.match(log[0]!.candidate, /\[mcp_servers\.ash\]/, "沙盘里放的是拼好的候选内容");
  assert.ok(log[0]!.candidate.includes(before), "候选 = 原文 + 那段,不是只剩那段");
  assert.equal(readFileSync(file, "utf8"), log[0]!.candidate, "批准之后落盘的就是批准过的那一份");
  assert.ok(!existsSync(log[0]!.sandbox), "问完沙盘要清掉");
}

// ㉓ **这一问不许在 server 里同步 spawn**（本轮审查 F2）：那样起的进程没有归属、收不回来
//    （Windows 真机实测包装退出后查询还活着），而同步调用期间整个 server 的事件循环被堵住。
//    唯一许可的起法是探测执行层。替身住在**测试文件**里,产品代码里一个都不许有。
{
  const raw = readFileSync(join(REPO_DIR, "server", "src", "auth", "user-cli-mcp.ts"), "utf8");
  // 注释里会提到旧写法(「上一版用的是 spawnSync」),按行剥掉注释再看代码本身。
  const code = raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.ok(!/spawnSync\(|\bspawn\(|execFile|execSync/.test(code),
    "写入侧不许自己起进程 —— 走 probeCli（本轮审查 F2）");
  assert.ok(/probeCli\(/.test(code), "问 codex 本人那一问必须走探测执行层");
}

// Windows 删不掉还开着的库文件：退出时那句 rmSync(stage) 会撞 EBUSY，断言全过也判红。
await releaseTmpDb();
console.log("test-user-cli-mcp: ✅ 23 组全过");
