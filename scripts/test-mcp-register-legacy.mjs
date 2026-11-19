// registerNaviMcp(setup 与 upgrade 共用)在「已经有 navi」时也得把还在的旧名登记(ash / harness)删掉:
// Navi 起 claude / codex 时注入的是 navi,用户配置里再留一条起同一个脚本的 ash,每一回合就挂两套一模一样的
// 工具(任务 Rz6wCPAMSnPU:第一次请求 17 万 token,连压三次失败)。同名却起着别的程序的,是用户自己的东西,不动。
//
// 用这台机器上**真装着**的 claude / codex 跑,配置全在临时 HOME / CODEX_HOME 里(用户自己那几份一个字节都不碰):
// 判据是「它们本人读完那份配置之后还列出哪些登记」,自己解析配置文件证明不了这件事。没装哪个就跳过哪个。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { parseCodexList } from "./codex-mcp.mjs";
import { claudeEntries } from "./mcp-register.mjs";
import { IS_WINDOWS, runCli, which } from "./platform.mjs";

const REGISTER = new URL("./mcp-register.mjs", import.meta.url).href;
const root = mkdtempSync(join(tmpdir(), "navi-mcp-legacy-"));

// ── 不起 CLI 的那一半:`claude mcp list` 的输出怎么读 ─────────────────────────────
assert.deepEqual(claudeEntries([
  "Checking MCP server health…", "",
  "navi: node /a/navi/mcp/dist/index.js - ✔ Connected",
  "ash: node C:\\a\\ash\\mcp\\dist\\index.js - ✘ Failed to connect",
  "harness: other-tool serve - ✘ Failed to connect",
  "kb: uv run kb-mcp - ✔ Connected",
].join("\r\n")), { registered: true, legacy: ["ash"], foreign: ["harness"] });
assert.deepEqual(claudeEntries("ashtray: node /x/mcp/dist/index.js - ok\n"), { registered: false, legacy: [], foreign: [] },
  "名字只认整段 `<名字>: `,不按前缀猜");
console.log("✓ 读得出 claude 列出的哪条是 Navi、哪条旧名起的是 Navi 的脚本、哪条是别的东西");

const clis = { claude: which("claude"), codex: which("codex") };
/** 每个场景一个干净的家:HOME / 各家配置目录都指进去,真 CLI 放在 PATH 最前面。 */
function stage(label) {
  const home = join(root, label);
  const entry = join(home, "navi-checkout", "mcp", "dist", "index.js");
  mkdirSync(join(home, ".codex"), { recursive: true });
  const env = {
    PATH: [...new Set(Object.values(clis).filter(Boolean).map((f) => dirname(f))), dirname(process.execPath), process.env.PATH].join(delimiter),
    HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"), XDG_CONFIG_HOME: join(home, ".config"),
    APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    ...(IS_WINDOWS ? { SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT, TEMP: process.env.TEMP, TMP: process.env.TMP } : {}),
  };
  return { home, entry, env };
}

/** 在那个家里跑一遍 registerNaviMcp,收回它说了什么。 */
function register({ home, entry, env, cwd = home }) {
  const code = `import { registerNaviMcp } from ${JSON.stringify(REGISTER)};
registerNaviMcp({ repo: ${JSON.stringify(dirname(dirname(dirname(entry))))}, port: 1,
  ok: (m) => console.log("OK " + m), warn: (m) => console.log("WARN " + m), say: (m) => console.log("SAY " + m) });`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd, env, encoding: "utf8", timeout: 180_000 });
  assert.equal(res.status, 0, `registerNaviMcp 自己挂了\n${res.stdout}\n${res.stderr}`);
  return res.stdout;
}

const claudeJson = (home) => join(home, ".claude.json");
const stdio = (command, args) => ({ type: "stdio", command, args, env: {} });
const codexToml = (servers) => servers.map(([name, command, args]) =>
  `[mcp_servers.${name}]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n`).join("\n");
const codexNames = ({ home, env }) => {
  const res = runCli("codex", ["mcp", "list", "--json"], { cwd: home, env, timeout: 60_000 });
  const listed = parseCodexList(res.status, res.stdout);
  assert.ok(listed.ok, `codex 读不动改完的配置:${listed.why}`);
  return listed.servers.map((s) => s.name).sort();
};

try {
  // ① navi 和起着 Navi 脚本的 ash 并存(跑过两次 setup / 手动加过 navi)→ 只剩 navi,kb 原样在。
  {
    const s = stage("both");
    const kb = stdio("kb-fake-cmd", ["serve"]);
    if (clis.claude) {
      writeFileSync(claudeJson(s.home), JSON.stringify({ mcpServers: { navi: stdio("node", [s.entry]), ash: stdio("node", [s.entry]), kb } }));
    }
    const kbToml = ["kb", "kb-fake-cmd", ["serve"]];
    if (clis.codex) writeFileSync(join(s.home, ".codex", "config.toml"), codexToml([["navi", "node", [s.entry]], ["ash", "node", [s.entry]], kbToml]));
    const out = register(s);
    if (clis.claude) {
      const servers = JSON.parse(readFileSync(claudeJson(s.home), "utf8")).mcpServers;
      assert.deepEqual(Object.keys(servers).sort(), ["kb", "navi"], `claude 里旧名 ash 该删掉\n${out}`);
      assert.deepEqual(servers.kb, kb, "别的 MCP 原样在");
      assert.match(out, /OK claude:Navi 已注册;旧 ash 条目已删掉/);
      console.log("✓ claude:navi 已在时,起着 Navi 脚本的旧名 ash 也删掉,kb 原样在");
    } else console.log("⚠ 没装 claude CLI,跳过 claude 那半");
    if (clis.codex) {
      assert.deepEqual(codexNames(s), ["kb", "navi"], `codex 里旧名 ash 该删掉\n${out}`);
      const toml = readFileSync(join(s.home, ".codex", "config.toml"), "utf8");
      assert.match(toml, /\[mcp_servers\.kb\]\ncommand = "kb-fake-cmd"\nargs = \["serve"\]/, "别的 MCP 原样在");
      assert.equal(toml.match(/\[mcp_servers\.navi\]/g)?.length, 1, "没再追加一份 navi");
      assert.match(out, /OK codex:Navi 已在,删掉了还留着的旧条目 .*原文件备份在 /);
      console.log("✓ codex:navi 已在时,起着 Navi 脚本的旧名 ash 也删掉(沙盘里删、留备份),kb 原样在");
    } else console.log("⚠ 没装 codex CLI,跳过 codex 那半");
  }

  // ② 同名的 ash 起的是别的程序 → 不是我们的,原样留着,报一句。
  {
    const s = stage("foreign");
    const other = stdio("some-other-tool", ["serve"]);
    let claudeBefore = null;
    if (clis.claude) {
      claudeBefore = JSON.stringify({ mcpServers: { navi: stdio("node", [s.entry]), ash: other } });
      writeFileSync(claudeJson(s.home), claudeBefore);
    }
    const tomlBefore = codexToml([["navi", "node", [s.entry]], ["ash", "some-other-tool", ["serve"]]]);
    if (clis.codex) writeFileSync(join(s.home, ".codex", "config.toml"), tomlBefore);
    const out = register(s);
    if (clis.claude) {
      assert.deepEqual(JSON.parse(readFileSync(claudeJson(s.home), "utf8")).mcpServers, JSON.parse(claudeBefore).mcpServers, `指着别处的 ash 不许动\n${out}`);
      assert.match(out, /SAY .*claude:ash 这个名字的条目起的不是 Navi 的 MCP 脚本/);
      console.log("✓ claude:同名却起着别的程序的 ash 原样留着,报一句");
    }
    if (clis.codex) {
      assert.equal(readFileSync(join(s.home, ".codex", "config.toml"), "utf8"), tomlBefore, `指着别处的 ash 一个字节都不动\n${out}`);
      assert.match(out, /SAY .*codex:ash 这个名字的条目起的不是 Navi 的 MCP 脚本/);
      console.log("✓ codex:同名却起着别的程序的 ash 原样留着,报一句");
    }
  }

  // ③ 同一个名字两处都有:个人配置里的 ash 是别的工具,当前项目(local 作用域)里的 ash 起着 Navi 的脚本。
  //    `claude mcp list` 在项目里看是合并视图;拿项目那条当依据去删 user 那条,删掉的就是人家的工具(审查实测)。
  if (clis.claude) {
    const s = stage("scopes");
    const project = join(s.home, "some-project");
    mkdirSync(project);
    const other = stdio("user-private-tool", ["serve"]);
    const local = { mcpServers: { ash: stdio("node", [s.entry]) } };
    writeFileSync(claudeJson(s.home), JSON.stringify({ mcpServers: { ash: other }, projects: { [realpathSync(project)]: local } }));
    const out = register({ ...s, cwd: project });
    const after = JSON.parse(readFileSync(claudeJson(s.home), "utf8"));
    assert.deepEqual(after.mcpServers.ash, other, `个人配置里同名的别的工具不许删\n${out}`);
    assert.ok(after.mcpServers.navi, `navi 照常登记到 user 作用域\n${out}`);
    assert.deepEqual(after.projects[realpathSync(project)].mcpServers, local.mcpServers, "项目自己的登记归项目,不替它动");
    assert.match(out, /SAY .*claude:ash 这个名字的条目起的不是 Navi 的 MCP 脚本/);
    console.log("✓ claude:认人和删除是同一个作用域 —— 项目里那条起着 Navi 不作数,个人配置里同名的别的工具不删");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("✅ 已有 navi 时旧名登记照样收掉,指着别处的不碰");
