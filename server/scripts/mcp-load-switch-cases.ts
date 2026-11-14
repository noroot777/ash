// 本轮审查两条类问题的回归:**逐家来源解析**(F1)与**逐家启停策略**(F2)。
//
// 为什么又单起一个文件:`test-ash-mcp-registry.ts` 和 `mcp-sources-cases.ts` 都已经接近
// 篇幅上限,而这两组各要搭好几份来源的沙盘。由那个文件调用,不是独立的回归入口。
//
// 判据全是 2026-10-31 本机真 CLI 逐格实测的(逐条依据记在 `catalog.ts` 那两家的 `source` /
// 注释里),这里只钉「ash 的判定、写入资格和文案跟实测结果一致」:
//  · opencode 默认目录里 `config.json` < `opencode.json` < `opencode.jsonc` 三份都读;
//  · `~/.opencode/` 是另一层全局配置,压过默认目录和 `OPENCODE_CONFIG` 那个文件;
//  · `OPENCODE_CONFIG` 给相对路径时按 **CLI 自己的工作目录**解 —— 解不出就看不准,不拦不写;
//  · 读取位置没逐格实测过的家,「没找到」只能答 unknown(absent 在派审里是硬拒);
//  · gemini 的根级 `mcp.excluded` / `mcp.allowed` 会把一条完全正确的登记打成 Blocked;
//  · 根级 `disabled_mcp_servers` 是 grok 专有的,codex 不认。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ASH_MCP_TABLE, ashMcpConfigDir } from "../src/mcp-registry/catalog.js";
import { registerAshMcp } from "../src/mcp-registry/register.js";
import {
  ashMcpHostFile, ashMcpHostSources, ashMcpStateIn, effectiveConfigState, readingFor,
} from "../src/mcp-registry/sources.js";

type Bench = (name: string) => { dir: string; host: string };
type Group = (name: string) => void;

const mech = (agentType: keyof typeof ASH_MCP_TABLE) => {
  const m = ASH_MCP_TABLE[agentType];
  assert.equal(m.kind, "file");
  if (m.kind !== "file") throw new Error("unreachable");
  return m;
};

const OC = (tag: string) => ({
  type: "local", command: ["node", `/${tag}.js`],
  environment: { ASH_URL: "http://127.0.0.1:54321" }, enabled: true,
});
const ocBody = (mcp: Record<string, unknown>) => `${JSON.stringify({ $schema: "x", mcp }, null, 2)}\n`;
const write = (file: string, body: string): string => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, "utf8");
  return file;
};
const ocEnv = (host: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
  ({ XDG_CONFIG_HOME: join(host, ".config"), ...extra });
/** 默认目录那一层(`$XDG_CONFIG_HOME/opencode/<名>`)。 */
const globalFile = (host: string, name: string) => join(host, ".config", "opencode", name);
/** 另一层全局配置(`~/.opencode/<名>`)。 */
const dotFile = (host: string, name: string) => join(host, ".opencode", name);

const ocState = (env: NodeJS.ProcessEnv, host: string, cwd?: string) =>
  effectiveConfigState(ashMcpHostSources("opencode", env, host, cwd), readingFor(mech("opencode")));

/** 宿主那几份配置的字节快照 —— 补接走过一遍之后逐字节比对(「只在缺的时候追加」)。 */
const snapshot = (files: string[]) => files.map((f) => readFileSync(f, "utf8"));

export async function checkLoadAndSwitches(bench: Bench, group: Group): Promise<void> {
  // ── ㉑ 默认目录里那三个文件名:全读、升序、落点取存在的最高那份 ────────────────
  {
    // ⒜ **只有 `config.json` 里有 ash**:真 CLI `opencode debug config --pure` 读得出、
    //    `mcp list` 是 connected。上一版压根没枚举这个名字,于是答 absent(派审硬拒),
    //    安装器还往优先级更高的 `opencode.json` 新写一条 —— 真 CLI 的生效 `ASH_URL`
    //    当场从用户那条换成了 ash 自己那条(本轮审查 F1 第一行)。
    const a = bench("load-config-json-only");
    const aFile = write(globalFile(a.host, "config.json"), ocBody({ ash: OC("CONFIGJSON") }));
    const envA = ocEnv(a.host);
    assert.ok(ashMcpHostSources("opencode", envA, a.host).some((s) => s.file === aFile),
      "`config.json` 必须在来源集合里(默认目录三个名字都读)");
    const stA = ocState(envA, a.host);
    assert.equal(stA.state, "present", `只有 config.json 有 ash ⇒ present:${stA.detail}`);
    assert.deepEqual(stA.fact?.launch?.args, ["/CONFIGJSON.js"], "生效的就是它那条");
    const beforeA = snapshot([aFile]);
    const rA = await registerAshMcp({
      agentType: "opencode", dir: ashMcpConfigDir("opencode", envA, a.host)!, hostHome: a.host, env: envA,
    });
    assert.ok(rA.ok, rA.ok ? "" : rA.why);
    assert.deepEqual(snapshot([aFile]), beforeA, "已经有生效的 ash ⇒ 一个字节都不许动");
    assert.equal(ashMcpHostFile("opencode", envA, a.host), aFile,
      "落点 = 存在的那几份里优先级最高的那个(这里只有它)");

    // ⒝ `config.json` + `opencode.json` 同在 ⇒ 后者赢(实测),落点也是后者。
    const b = bench("load-config-and-json");
    const bLow = write(globalFile(b.host, "config.json"), ocBody({ ash: OC("LOW") }));
    const bHigh = write(globalFile(b.host, "opencode.json"), ocBody({ ash: OC("HIGH") }));
    const envB = ocEnv(b.host);
    assert.deepEqual(ashMcpHostSources("opencode", envB, b.host).map((s) => s.file), [bLow, bHigh],
      "来源集合按实测加载序升序排(config.json 在前)");
    assert.deepEqual(ocState(envB, b.host).fact?.launch?.args, ["/HIGH.js"], "高的那份赢");
    assert.equal(ashMcpHostFile("opencode", envB, b.host), bHigh, "落点是优先级最高那份");

    // ⒞ 一份都不存在 ⇒ 新建的仍是 `relative` 那个名字,不会因为 `config.json` 排第一就建它。
    const c = bench("load-none-exists");
    assert.equal(ashMcpHostFile("opencode", ocEnv(c.host), c.host), globalFile(c.host, "opencode.json"),
      "一个都没有时新建 opencode.json(加载序最低那个名字不是新建落点)");
    group("默认目录三个文件名:都读、升序、落点取存在的最高那份、新建仍走 relative");
  }

  // ── ㉗ `~/.opencode/` 这另一层全局配置 ───────────────────────────────────
  {
    // ⒟ ash 只在 `~/.opencode/opencode.json`:真 CLI 读得出(它压过默认目录)。
    const a = bench("load-dot-opencode");
    const aFile = write(dotFile(a.host, "opencode.json"), ocBody({ ash: OC("DOT") }));
    const envA = ocEnv(a.host);
    const stA = ocState(envA, a.host);
    assert.equal(stA.state, "present", `~/.opencode 那份也要算进来源:${stA.detail}`);
    assert.deepEqual(stA.fact?.launch?.args, ["/DOT.js"]);
    const beforeA = snapshot([aFile]);
    const rA = await registerAshMcp({
      agentType: "opencode", dir: ashMcpConfigDir("opencode", envA, a.host)!, hostHome: a.host, env: envA,
    });
    assert.ok(rA.ok, rA.ok ? "" : rA.why);
    assert.deepEqual(snapshot([aFile]), beforeA, "已经接好了 ⇒ 不写");

    // ⒠ 默认目录开着、`~/.opencode/opencode.jsonc` 只写 `{enabled:false}` ⇒ 关着
    //    (那一层比默认目录高,而开关跨来源继承 —— 两条都是实测)。
    const b = bench("load-dot-wins");
    write(globalFile(b.host, "opencode.json"), ocBody({ ash: OC("GLOBAL") }));
    write(dotFile(b.host, "opencode.jsonc"), ocBody({ ash: { enabled: false } }));
    const stB = ocState(ocEnv(b.host), b.host);
    assert.equal(stB.state, "disabled", `~/.opencode 那层压得住默认目录:${stB.detail}`);

    // ⒡ `~/.opencode` 目录空着 ⇒ 它一份来源都不贡献,更不会成为新建落点。
    const c = bench("load-dot-empty");
    mkdirSync(join(c.host, ".opencode"), { recursive: true });
    const cFile = write(globalFile(c.host, "opencode.json"), ocBody({}));
    const envC = ocEnv(c.host);
    assert.deepEqual(ashMcpHostSources("opencode", envC, c.host).map((s) => s.file), [cFile],
      "额外目录那一层只枚举真实存在的文件(ash 不替用户造第二个全局配置目录)");
    assert.equal(ashMcpHostFile("opencode", envC, c.host), cFile, "落点还是默认目录那份");
    group("~/.opencode:算进来源、压得住默认目录、空着时不贡献来源也不当新建落点");
  }

  // ── ㉛ 指到文件的变量给**相对路径** ─────────────────────────────────────
  {
    const a = bench("load-relative-config");
    const work = join(a.host, "work");
    const rel = "ws-config.json";
    const absFile = write(join(work, rel), ocBody({ ash: OC("RELATIVE") }));
    write(globalFile(a.host, "opencode.json"), ocBody({}));
    const envA = ocEnv(a.host, { OPENCODE_CONFIG: rel });

    // ⒢ 不知道工作目录 ⇒ 这份来源**证不出来**:答看不准,不拦人、不写,也不拿它当落点。
    const blind = ocState(envA, a.host);
    assert.equal(blind.state, "unknown", `相对路径解不出 ⇒ 看不准:${blind.detail}`);
    assert.match(blind.detail, /相对路径/, `文案要说清是哪种解不出:${blind.detail}`);
    assert.notEqual(ashMcpHostFile("opencode", envA, a.host), rel, "证不出来的来源不许当写入落点");
    const before = snapshot([absFile, globalFile(a.host, "opencode.json")]);
    const r = await registerAshMcp({
      agentType: "opencode", dir: ashMcpConfigDir("opencode", envA, a.host)!, hostHome: a.host, env: envA,
    });
    assert.equal(r.ok, false, "看不准就不写");
    assert.match(r.ok ? "" : r.why, /看不准/);
    assert.deepEqual(snapshot([absFile, globalFile(a.host, "opencode.json")]), before,
      "一个字节都没动(上一版按 server 自己的目录去找、找不到就当 absent,于是新写一条顶掉了它)");

    // ⒣ 带上 CLI 真正的工作目录 ⇒ 解得准,跟真 CLI 同口径(present)。
    const withCwd = ocState(envA, a.host, work);
    assert.equal(withCwd.state, "present", `带上 cwd 就解得准:${withCwd.detail}`);
    assert.deepEqual(withCwd.fact?.launch?.args, ["/RELATIVE.js"]);
    group("相对路径的配置变量:带 cwd 才解、解不出就看不准不写");
  }

  await checkSwitches(bench, group);
}

/** F2:逐家启停策略(gemini 的根级名单、grok 专有的根级数组)。 */
async function checkSwitches(bench: Bench, group: Group): Promise<void> {
  const gemini = mech("gemini");
  const geminiFile = (host: string) => join(host, ".gemini", "settings.json");
  const geminiBody = (extra: Record<string, unknown>) => `${JSON.stringify({
    mcpServers: { ash: { command: "node", args: ["/live.js"] }, other: { command: "node", args: ["/o.js"] } },
    ...extra,
  }, null, 2)}\n`;

  // ── gemini:根级 `mcp.excluded` / `mcp.allowed` ─────────────────────────
  {
    for (const [tag, extra, want] of [
      ["excluded 列着 ash", { mcp: { excluded: ["ash"] } }, "disabled"],
      ["allowed 白名单里没有 ash", { mcp: { allowed: ["other"] } }, "disabled"],
      ["allowed 是空数组", { mcp: { allowed: [] } }, "disabled"],
      ["allowed 列着 ash", { mcp: { allowed: ["ash"] } }, "present"],
      ["没配任何名单", {}, "present"],
    ] as const) {
      const b = bench("switch-gemini");
      const file = write(geminiFile(b.dir), geminiBody(extra));
      const state = ashMcpStateIn(b.dir, "gemini", {});
      assert.equal(state.state, want, `${tag} ⇒ ${want}(真 gemini 0.60.0 实测):${state.detail}`);
      if (want !== "disabled") continue;
      assert.match(state.detail, /mcp\.(excluded|allowed)/, `说清是哪一行在挡:${state.detail}`);
      // 安装器:不许替用户打开那两个名单。
      const before = readFileSync(file, "utf8");
      const r = await registerAshMcp({ agentType: "gemini", dir: b.dir, hostHome: b.host, env: {} });
      assert.equal(r.ok, false, "被挡住了就不是「已接好」");
      assert.match(r.ok ? "" : r.why, /没有替你打开/);
      assert.equal(readFileSync(file, "utf8"), before, "名单一个字节都不许改");
    }

    // 压根没登记时也要如实说:名单摆在那儿,补一条进去也是条用不上的登记(真 gemini 把它
    // 打成 Blocked)。**只问规范名** —— 历史名没在白名单里是常态,拿它说「关掉了」会把一份
    // 完全可用的配置判成 disabled。
    const bare = (extra: Record<string, unknown>) => `${JSON.stringify({
      mcpServers: { other: { command: "node", args: ["/o.js"] } }, ...extra,
    }, null, 2)}\n`;
    for (const [tag, extra, want] of [
      ["excluded 列着 ash、压根没登记", { mcp: { excluded: ["ash"] } }, "disabled"],
      ["白名单里没有 ash、压根没登记", { mcp: { allowed: ["other"] } }, "disabled"],
      ["白名单里有 ash、压根没登记", { mcp: { allowed: ["ash"] } }, "absent"],
      ["白名单里有 ash,历史名不在", { mcp: { allowed: ["ash", "other"] } }, "absent"],
    ] as const) {
      const b = bench("switch-gemini-bare");
      write(geminiFile(b.dir), bare(extra));
      const state = ashMcpStateIn(b.dir, "gemini", {});
      assert.equal(state.state, want, `${tag} ⇒ ${want}:${state.detail}`);
    }

    // 那两个名单写成别的类型 ⇒ 看不准(那种写法 gemini 怎么处理没实测过),不拦也不写。
    const c = bench("switch-gemini-odd");
    write(geminiFile(c.dir), geminiBody({ mcp: { excluded: "ash" } }));
    const odd = ashMcpStateIn(c.dir, "gemini", {});
    assert.equal(odd.state, "unknown", `名单不是数组 ⇒ 看不准:${odd.detail}`);
    assert.match(odd.detail, /没实测/, odd.detail);
    assert.deepEqual(gemini.switches, { off: ["mcp", "excluded"], only: ["mcp", "allowed"] },
      "这两个键路径是实测出来的,别改成别家的字段名");
    group("gemini 的根级名单:挡住就判关着(含空白名单)、说清哪一行、不替用户打开、怪写法看不准");
  }

  // ── grok vs codex:同一个根级数组,一家认一家不认 ────────────────────────
  {
    const toml = 'disabled_mcp_servers = ["ash"]\n\n[mcp_servers.ash]\ncommand = "node"\nargs = ["/x.js"]\nenabled = true\n';
    const g = bench("switch-grok-root");
    write(join(g.dir, "config.toml"), toml);
    const gState = ashMcpStateIn(g.dir, "grok", {});
    assert.equal(gState.state, "disabled", `grok 认这个键(实测 \`grok mcp list\` 打 (disabled)):${gState.detail}`);
    assert.match(gState.detail, /disabled_mcp_servers/, "说清是哪一行");

    const c = bench("switch-codex-root");
    write(join(c.dir, "config.toml"), toml);
    const cState = ashMcpStateIn(c.dir, "codex", {});
    assert.equal(cState.state, "present",
      `codex 压根不认这个键(实测 \`codex mcp list --json\` 仍 enabled:true)—— 上一版两家共用格式族，`
      + `给 grok 关一次 ash 会把 codex 这条能用的连接也判成关着:${cState.detail}`);
    assert.equal(mech("codex").switches, undefined, "codex 不许声明这个开关");
    assert.deepEqual(mech("grok").switches, { off: ["disabled_mcp_servers"] }, "grok 才有");

    // 安装器那一侧同理:grok 那份不替用户打开,codex 那份照常认得出已有登记。
    const rg = await registerAshMcp({ agentType: "grok", dir: g.dir, hostHome: g.host, env: {} });
    assert.equal(rg.ok, false, "grok:被根级那行关着 ⇒ 不写");
    assert.match(rg.ok ? "" : rg.why, /没有替你打开/);
    group("根级 disabled_mcp_servers:grok 认、codex 不认(格式族只读结构,启停归逐家声明)");
  }
}
