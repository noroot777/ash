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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { ensureAshMcp, extractTomlTables, hostAshMcp, readAshMcp } from "../src/auth/user-cli-mcp.js";
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
  const state = ensureAshMcp(dir, "claude", host);
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
  assert.equal(ensureAshMcp(dir, "claude", host).configured, true);
  assert.ok(readJson(join(dir, ".claude.json")).mcpServers.ash, "该建的文件要建出来");
}

// ③ 幂等:第二次调用一个字节都不该改(CLI 可能正在写这份文件)。
{
  const { host, dir } = bench({ claude: HOST_CLAUDE });
  ensureAshMcp(dir, "claude", host);
  const first = readFileSync(join(dir, ".claude.json"), "utf8");
  const again = ensureAshMcp(dir, "claude", host);
  assert.equal(again.configured, true);
  assert.equal(readFileSync(join(dir, ".claude.json"), "utf8"), first, "已经有了就不该再写");
}

// ④ 已有登记不覆盖 —— 包括历史名 harness(用户可能自己改过 URL / 路径)。
{
  const { host, dir } = bench({ claude: HOST_CLAUDE });
  const mine = { type: "stdio", command: "node", args: ["/我改过的/index.js"], env: {} };
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ mcpServers: { harness: mine } }), "utf8");
  const state = ensureAshMcp(dir, "claude", host);
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
  const state = ensureAshMcp(dir, "claude", host);
  assert.equal(state.configured, false);
  assert.ok(state.problem && state.problem.includes(".claude.json"), "得说清楚是哪份文件");
  assert.equal(readFileSync(join(dir, ".claude.json"), "utf8"), broken, "坏文件也不许被覆盖");
}

// ⑥ 宿主也没有:没 build 过 mcp 就诚实说补不上,build 过就按仓库这份现拼一条。
{
  const { host, dir } = bench();
  const state = ensureAshMcp(dir, "claude", host);
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
  ensureAshMcp(dir, "claude", host);
  assert.equal(readFileSync(join(host, ".claude.json"), "utf8"), HOST_CLAUDE, "宿主配置只读");
}

// ⑧ codex:整段 [mcp_servers.ash] 连子表一起搬,后面无关的表不许跟着过来。
{
  const hostToml =
    `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/ash/mcp/dist/index.js"]\n\n` +
    `[mcp_servers.ash.env]\nASH_URL = "http://localhost:4317"\n\n` +
    `[projects."/opt/ash"]\ntrust_level = "trusted"\n`;
  const { host, dir } = bench({ codex: hostToml });
  const state = ensureAshMcp(dir, "codex", host);
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
  assert.equal(ensureAshMcp(dir, "codex", host).configured, true);
  const written = readFileSync(join(dir, "config.toml"), "utf8");
  assert.ok(written.includes("[mcp_servers.ash]"), "表头要落成规范名");
  assert.ok(written.includes("/old/index.js"), "定义本身照搬");
}

// ⑩ codex 已有 config.toml:追加而不是重写(里面还有用户自己的设置)。
{
  const { host, dir } = bench({ codex: `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n` });
  writeFileSync(join(dir, "config.toml"), `model = "gpt-5.6"\n`, "utf8");
  ensureAshMcp(dir, "codex", host);
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
  ensureAshMcp(dir, "codex", host);
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
    const state = ensureAshMcp(dir, "codex", host);
    assert.equal(state.configured, true, `已有登记要认得出：${JSON.stringify(existing)}`);
    assert.equal(readFileSync(join(dir, "config.toml"), "utf8"), existing, "认出来了就一个字都不写");
  }
  {
    const { host, dir } = bench({ codex: HOST });
    const off = `[mcp_servers.ash]\ncommand = "node"\nenabled = false\n`;
    writeFileSync(join(dir, "config.toml"), off, "utf8");
    const state = ensureAshMcp(dir, "codex", host);
    assert.equal(state.configured, false, "关着的登记不算接好");
    assert.match(state.problem ?? "", /enabled = false/);
    assert.equal(readFileSync(join(dir, "config.toml"), "utf8"), off, "关着的不替用户打开，也不再追加一份");
  }
  {
    const { host, dir } = bench({ codex: HOST });
    // 多行字符串里的假表头：扫描器自己判不了（doubt），宁可不写。
    const odd = `notes = """\n[mcp_servers.ash]\n"""\n`;
    writeFileSync(join(dir, "config.toml"), odd, "utf8");
    const state = ensureAshMcp(dir, "codex", host);
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
  const state = ensureAshMcp(dir, agent, host);
  assert.equal(state.configured, false, `${agent}:读不动不能报「已接好」`);
  assert.match(state.problem ?? "", /读不出来/, `${agent}:要说清是读不出来`);
  assert.equal(readFileSync(join(file, "keep"), "utf8"), "x", `${agent}:读不动的东西原样留着`);
}

// ⑱ **补写完要自己再读一遍，验不过就原样还回去**（新链第 6 轮审查 F1）：补进去的那段是从
//    宿主配置里搬来的，拼完的文件未必还读得通 —— 而读不通的 config.toml 对 codex 是整份
//    拒载，用户别的 MCP 一起没了，界面上却写着「已接好」。
{
  // 宿主那条是**关着的**:搬过来照样是关着的,那不叫接好(agent 照样交不了卷)。
  const { host, dir } = bench({ codex: `[mcp_servers.ash]\ncommand = "node"\nenabled = false\n` });
  const before = `model = "gpt"\n`;
  const file = join(dir, "config.toml");
  writeFileSync(file, before, "utf8");
  const state = ensureAshMcp(dir, "codex", host);
  assert.equal(state.configured, false, "补写完读不出启用着的登记,不许报「已接好」");
  assert.match(state.problem ?? "", /还原/, "要说清已经还原了");
  assert.equal(readFileSync(file, "utf8"), before, "原样还回补写前的样子");

  // 原来压根没有这个文件:还原 = 把它删掉,不留一份自己都读不通的残骸。
  const second = bench({ codex: `[mcp_servers.ash]\ncommand = "node"\nenabled = false\n` });
  assert.equal(ensureAshMcp(second.dir, "codex", second.host).configured, false);
  assert.equal(existsSync(join(second.dir, "config.toml")), false, "原来没有的文件不许留下半截");

  // 对照:宿主那条是开着的 → 补写、验过、如实报已接好。
  const third = bench({ codex: `[mcp_servers.ash]\ncommand = "node"\nargs = ["/opt/x.js"]\n` });
  writeFileSync(join(third.dir, "config.toml"), before, "utf8");
  assert.equal(ensureAshMcp(third.dir, "codex", third.host).configured, true, "开着的照样补得上");
  assert.match(readFileSync(join(third.dir, "config.toml"), "utf8"), /\[mcp_servers\.ash\]/);
}

// Windows 删不掉还开着的库文件：退出时那句 rmSync(stage) 会撞 EBUSY，断言全过也判红。
await releaseTmpDb();
console.log("test-user-cli-mcp: ✅ 18 组全过");
