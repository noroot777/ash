// claude / codex 之外那十几家 CLI 的旧名登记(ash / harness)收成 navi(mcp-legacy-retire.mjs):
//   已有 navi ⇒ 旧名删掉;还没有 ⇒ 原地改名(值、注释、键序都不动);起的不是 Navi 脚本 / 关着的 ⇒ 不动;
//   起的脚本已经不在磁盘上 ⇒ 删掉,让紧接着的 registerHostMcp 按这份检出补一条。
// 全在临时 HOME 里跑,用户自己的配置一个字节都不碰;判据是改完的文件本身,再用 effectiveState 认一遍「这家最终看到什么」。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeJsonMember, renameJsonMember } from "./json-edit.mjs";
import { retireLegacyHostMcp } from "./mcp-legacy-retire.mjs";
import { HOST_SITES, effectiveState, hostMcpSources } from "./mcp-host-sources.mjs";

// ── json-edit 的两个新改法 ─────────────────────────────────────────────
{
  const doc = '{\n  // 我的服务\n  "mcpServers": {\n    "ash": { "command": "node" },\n    "kb": { "command": "kb" }\n  }\n}\n';
  assert.equal(removeJsonMember(doc, "mcpServers", "ash").body, '{\n  // 我的服务\n  "mcpServers": {\n    "kb": { "command": "kb" }\n  }\n}\n');
  assert.equal(removeJsonMember(doc, "mcpServers", "kb").body, '{\n  // 我的服务\n  "mcpServers": {\n    "ash": { "command": "node" }\n  }\n}\n',
    "删最后一条:前一条后面那个逗号一起收掉");
  const only = '{ "mcpServers": {\n  "ash": {}\n} }';
  assert.equal(removeJsonMember(only, "mcpServers", "ash").body, '{ "mcpServers": {\n} }', "唯一一条也删得干净");
  assert.equal(removeJsonMember('{ "mcpServers": { "a": 1, "b": 2, } }', "mcpServers", "b").body, '{ "mcpServers": { "a": 1,  } }', "尾逗号写法:连它后面那个逗号一起删");
  assert.ok(removeJsonMember('{ "mcpServers": { "ash": 1, "ash": 2 } }', "mcpServers", "ash").why, "同名两条:认不准就不动");
  assert.ok(removeJsonMember('{ "mcpServers": { "kb": 1 } }', "mcpServers", "ash").why, "没有那条:不动");
  assert.equal(renameJsonMember(doc, "mcpServers", "ash", "navi").body, doc.replace('"ash"', '"navi"'), "改名只换键那几个字节");
  assert.ok(renameJsonMember('{ "mcpServers": { "ash": 1, "navi": 2 } }', "mcpServers", "ash", "navi").why, "目标名已经有了就不改");
  console.log("✓ json-edit:删一条 / 改一条的键名,别的字节原样");
}

const root = mkdtempSync(join(tmpdir(), "navi-legacy-retire-"));
let n = 0;
/** 一个干净的家;entry = 磁盘上真有的那份 Navi MCP 脚本。 */
function stage() {
  const home = join(root, `h${n += 1}`);
  const entry = join(home, "navi-checkout", "mcp", "dist", "index.js");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, "");
  const env = { XDG_CONFIG_HOME: join(home, ".config") };
  const put = (rel, text) => { mkdirSync(dirname(join(home, rel)), { recursive: true }); writeFileSync(join(home, rel), text); return join(home, rel); };
  const state = (agentType) => effectiveState(hostMcpSources(agentType, { env, home }), HOST_SITES[agentType]);
  const retire = (agentType) => retireLegacyHostMcp({ agentType, env, home });
  return { home, entry, env, put, state, retire };
}
const js = (v) => JSON.stringify(v);

try {
  // ① gemini:navi 和起着 Navi 脚本的 ash 并存 → ash 删掉,注释和 kb 原样,留备份。
  {
    const s = stage();
    const before = `{\n  // 我自己的设置\n  "theme": "dark",\n  "mcpServers": {\n    "navi": { "command": "node", "args": [${js(s.entry)}] },\n    "ash": { "command": "node", "args": [${js(s.entry)}], "env": { "ASH_URL": "http://127.0.0.1:4317" } },\n    "kb": { "command": "kb-mcp" }\n  }\n}\n`;
    const file = s.put(".gemini/settings.json", before);
    const r = s.retire("gemini");
    assert.equal(r.skipped, null);
    assert.deepEqual(r.changed.map((c) => [c.removed, c.renamed]), [[["ash"], null]]);
    const after = readFileSync(file, "utf8");
    assert.equal(after, before.replace(/    "ash": .*\n/, ""));
    assert.equal(readFileSync(r.changed[0].backup, "utf8"), before, "原文件留了备份");
    assert.equal(s.state("gemini").name, "navi");
    console.log("✓ gemini:navi 已在时旧名 ash 删掉,注释、别的登记原样,留备份");
  }

  // ② opencode(jsonc):只有起着 Navi 脚本的 ash → 原地改名,值(env、开关)一个字节不动。
  {
    const s = stage();
    const before = `{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    // Navi\n    "ash": { "type": "local", "command": ["node", ${js(s.entry)}], "environment": { "ASH_URL": "http://127.0.0.1:4317" } },\n    "kb": { "type": "local", "command": ["kb-mcp"] }\n  }\n}\n`;
    const file = s.put(".config/opencode/opencode.jsonc", before);
    assert.equal(s.state("opencode").name, "ash");
    const r = s.retire("opencode");
    assert.equal(r.skipped, null);
    assert.deepEqual(r.changed.map((c) => [c.removed, c.renamed]), [[[], "ash"]]);
    assert.ok(r.changed[0].launch.includes(s.entry), "交回改名那条起的是什么,调用方据此提醒是不是这份检出");
    assert.equal(readFileSync(file, "utf8"), before.replace('"ash":', '"navi":'));
    assert.equal(s.state("opencode").name, "navi");
    assert.deepEqual(s.retire("opencode").changed, [], "再跑一次什么都不改");
    console.log("✓ opencode:只有旧名 ash 时原地改名成 navi,环境变量和注释原样;再跑一次不动");
  }

  // ③ opencode:ash 起的脚本早就不在了(指着删掉的 worktree)→ 删掉,留给 registerHostMcp 补。
  {
    const s = stage();
    const gone = join(s.home, "deleted-worktree", "mcp", "dist", "index.js");
    const file = s.put(".config/opencode/opencode.json", js({ mcp: { ash: { type: "local", command: ["node", gone] }, kb: { type: "local", command: ["kb-mcp"] } } }));
    const r = s.retire("opencode");
    assert.equal(r.skipped, null);
    assert.deepEqual(r.changed.map((c) => [c.removed, c.renamed]), [[["ash"], null]]);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).mcp), ["kb"]);
    assert.equal(s.state("opencode").state, "absent");
    console.log("✓ opencode:旧名那条起的脚本已经不在磁盘上 → 删掉,不改名成一条起不来的 navi");
  }

  // ④ grok(TOML):没有 navi → `[mcp_servers.ash]` 连同子表原地改名;起着别的程序的 harness 不动。
  {
    const s = stage();
    const before = `# 我的 grok 配置\nmodel = "grok-5"\n\n[mcp_servers.ash]\ncommand = "node"\nargs = [${js(s.entry)}] # Navi\n\n[mcp_servers.ash.env]\nASH_URL = "http://127.0.0.1:4317"\n\n[mcp_servers.harness]\ncommand = "other-tool"\nargs = ["serve"]\n`;
    const file = s.put(".grok/config.toml", before);
    const r = s.retire("grok");
    assert.equal(r.skipped, null);
    assert.deepEqual(r.changed.map((c) => [c.removed, c.renamed]), [[[], "ash"]]);
    assert.deepEqual(r.foreign, ["harness"]);
    assert.equal(readFileSync(file, "utf8"), before.replace("[mcp_servers.ash]", "[mcp_servers.navi]").replace("[mcp_servers.ash.env]", "[mcp_servers.navi.env]"));
    console.log("✓ grok:旧名 ash 的表头(连子表)原地改名;同名却起着别的程序的 harness 原样留着、报出来");
  }

  // ⑤ grok:navi 已在 → ash 那几张表整段删掉,别的原样。
  {
    const s = stage();
    const navi = `[mcp_servers.navi]\ncommand = "node"\nargs = [${js(s.entry)}]\n\n`;
    const kb = `[mcp_servers.kb]\ncommand = "kb-mcp"\n`;
    const file = s.put(".grok/config.toml", `${navi}[mcp_servers.ash]\ncommand = "node"\nargs = [${js(s.entry)}]\n\n[mcp_servers.ash.env]\nASH_URL = "x"\n\n${kb}`);
    const r = s.retire("grok");
    assert.equal(r.skipped, null);
    assert.equal(readFileSync(file, "utf8"), navi + kb);
    console.log("✓ grok:navi 已在时旧名 ash 的表整段删掉");
  }

  // ⑥ 关着的不动:opencode `enabled:false`;gemini 根级 `mcp.excluded` 点了 ash(合起来看是关着的)。
  {
    const s = stage();
    const off = js({ mcp: { ash: { type: "local", command: ["node", s.entry], enabled: false } } });
    const file = s.put(".config/opencode/opencode.json", off);
    assert.deepEqual(s.retire("opencode").changed, []);
    assert.equal(readFileSync(file, "utf8"), off);
    const excluded = js({ mcp: { excluded: ["ash"] }, mcpServers: { ash: { command: "node", args: [s.entry] } } });
    const gemini = s.put(".gemini/settings.json", excluded);
    const r = s.retire("gemini");
    assert.deepEqual(r.changed, []);
    assert.equal(readFileSync(gemini, "utf8"), excluded, "改名会替用户把它打开,一个字节都不动");
    console.log("✓ 关着的旧名条目(自己关的、被根级名单关的)都不动");
  }

  // ⑦ 只有起着别的程序的 ash:不写,报出来;没装配置的那家什么都不做、也不建目录。
  {
    const s = stage();
    const foreign = js({ mcpServers: { ash: { command: "some-other-tool" } } });
    const file = s.put(".kimi-code/mcp.json", foreign);
    const r = s.retire("kimi");
    assert.deepEqual([r.changed, r.foreign], [[], ["ash"]]);
    assert.equal(readFileSync(file, "utf8"), foreign);
    assert.deepEqual(s.retire("cursor"), { changed: [], foreign: [], unsure: [], readonly: [], skipped: null });
    assert.ok(!existsSync(join(s.home, ".cursor")), "没有配置的那家不建目录");
    console.log("✓ 只有起着别的程序的旧名时一个字节都不写;没配置的那家不建目录");
  }

  // ⑧ grok:「起的是什么」只看服务自己那张表的 command / args(审查第 3 轮 R5)。
  //    子表里恰好叫 command 的环境变量写着 Navi 路径 ⇒ 不是我们的,原样留着;多行数组里的 Navi 路径照样认得出来。
  {
    const s = stage();
    const navi = `[mcp_servers.navi]\ncommand = "node"\nargs = [${js(s.entry)}]\n`;
    const trap = `${navi}[mcp_servers.ash]\ncommand = "another-mcp"\nargs = ["serve"]\n[mcp_servers.ash.env]\ncommand = ${js(s.entry)}\n`;
    const file = s.put(".grok/config.toml", trap);
    const r = s.retire("grok");
    assert.deepEqual([r.changed, r.foreign], [[], ["ash"]]);
    assert.equal(readFileSync(file, "utf8"), trap, "子表里的路径不算它起的东西,一个字节都不动");
    const multi = `${navi}\n[mcp_servers.ash]\ncommand = "node" # Navi\nargs = [\n  # 脚本\n  ${js(s.entry)},\n]\n\n[mcp_servers.kb]\ncommand = "kb-mcp"\n`;
    writeFileSync(file, multi);
    const r2 = s.retire("grok");
    assert.deepEqual(r2.changed.map((c) => c.removed), [["ash"]], "多行数组里的 Navi 脚本照样认得出来");
    assert.equal(readFileSync(file, "utf8"), `${navi}\n[mcp_servers.kb]\ncommand = "kb-mcp"\n`);
    const odd = `[mcp_servers.ash]\ncommand = "node"\nargs = [${js(s.entry)}] extra\n`;
    writeFileSync(file, odd);
    const r3 = s.retire("grok");
    assert.deepEqual([r3.changed, r3.unsure], [[], ["ash"]], "启动参数那一行读不通 ⇒ 认不准,不动");
    assert.equal(readFileSync(file, "utf8"), odd);
    // 多行基本字符串里按 TOML 全集解转义:\u002f 写的 / 照样认得出是 Navi 的脚本;认不出的转义算认不准,不当成别人的。
    const escaped = `${navi}[mcp_servers.ash]\ncommand = "node"\nargs = ["""\n${s.entry.replaceAll("\\", "\\\\").replaceAll("/", "\\u002f")}"""]\n`;
    writeFileSync(file, escaped);
    assert.deepEqual(s.retire("grok").changed.map((c) => c.removed), [["ash"]], "\\u 转义写的 Navi 路径没认出来");
    const bogus = `${navi}[mcp_servers.ash]\ncommand = "node"\nargs = ["""\n${s.entry.replaceAll("\\", "\\\\")}\\q"""]\n`;
    writeFileSync(file, bogus);
    const r4 = s.retire("grok");
    assert.deepEqual([r4.changed, r4.foreign, r4.unsure], [[], [], ["ash"]], "认不出的转义该算认不准");
    console.log("✓ grok:只认服务自己那张表的启动命令 —— 子表里的同名键不算,多行数组、\\u 转义都认得出,读不通的不动");
  }

  // ⑨ 已有 navi 时,被 gemini 根级 mcp.excluded 挡掉的 ash 也不动(关着就是关着,不看别的登记在不在)。
  {
    const s = stage();
    const doc = js({ mcp: { excluded: ["ash"] }, mcpServers: { navi: { command: "node", args: [s.entry] }, ash: { command: "node", args: [s.entry] } } });
    const file = s.put(".gemini/settings.json", doc);
    assert.deepEqual(s.retire("gemini").changed, []);
    assert.equal(readFileSync(file, "utf8"), doc);
    console.log("✓ gemini:已有 navi 时,被根级名单挡掉的旧名条目照样不动");
  }

  // ⑩ 只在 OPENCODE_CONFIG_CONTENT 里的旧名登记:改不了,报出来是哪一份。
  {
    const s = stage();
    s.env.OPENCODE_CONFIG_CONTENT = js({ mcp: { ash: { type: "local", command: ["node", s.entry] } } });
    const r = s.retire("opencode");
    assert.deepEqual([r.changed, r.readonly], [[], ["$OPENCODE_CONFIG_CONTENT"]]);
    console.log("✓ opencode:只在环境变量里的那份旧名登记改不了,如实报出来");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("✅ claude / codex 之外的各家旧名登记都能收成 navi,别人的、关着的不碰");
