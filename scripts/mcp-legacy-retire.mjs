// 改名之前留在各家 CLI 用户配置里的旧名登记(`ash`、更早的 `harness`)收成 navi —— claude / codex 之外的那十几家。
//
// 为什么要收:旧名那条起的是同一个 Navi MCP 脚本。navi 已经在时它还留着,这家 CLI 每一回合就挂两套一模一样的工具;
// 只有旧名时它能用,但名字跟 Navi 注入、文档、排查口径都对不上。所以:
//   · 这份配置里已经有 navi(或者别的那份里生效的就是 navi)⇒ 旧名那条删掉;
//   · 还没有 navi ⇒ 旧名那条**原地改名**成 navi —— 值一个字节都不动(用户调过的开关、环境变量、工具审批都在),
//     注释、键序、别的登记也都原样(json-edit.mjs 的无损改法;TOML 只改表头);
//   · 旧名那条起的不是 Navi 的 MCP 脚本(同名的别的东西)⇒ 不动,报一句;
//   · 关着的旧名条目不动:它本来就不挂工具,改它反而可能替用户把开关拨了;
//   · 旧名那条起的脚本已经不在磁盘上了(指着早删掉的 worktree)⇒ 改名也起不来,直接删掉,
//     紧接着 registerHostMcp 按这份检出补一条 navi。
// 改之前把「这家 CLI 合起来最终看到什么」(mcp-host-sources.mjs 的 effectiveState)在**改完的候选**上再算一遍:
// 改前生效的是旧名、改后生效的必须是 navi,而且这几份里再也没有起 Navi 脚本的旧名;算不出来(看不准)一律不写。
// 写盘走 config-publish.mjs 的发布事务(只替换读到的那一版、留备份、读回来比对)。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { publishConfirmed, readForWrite } from "./config-publish.mjs";
import { pointsAtNaviMcp } from "./codex-mcp.mjs";
import { readJsonLoose, removeJsonMember, renameJsonMember } from "./json-edit.mjs";
import { HOST_SITES, LEGACY_NAMES, NAVI, effectiveState, hostMcpSources } from "./mcp-host-sources.mjs";
import { scanTomlServers, stripTomlNoise, tomlKeyPath, unquoteToml } from "./toml-scan.mjs";

/** 启动参数里那个 Navi MCP 脚本是绝对路径、而且已经不在了 ⇒ 这条登记起不来。 */
const deadScript = (args) =>
  args.some((a) => typeof a === "string" && pointsAtNaviMcp(a) && /index\.js$/.test(a) && isAbsolute(a) && !existsSync(a));

const HEADER = /^\[\[?((?:[^\]"']|"(?:[^"\\]|\\.)*"|'[^']*')*)\]\]?/;

/** 一份 TOML 里各个 `[mcp_servers.<名>…]` 表头在第几行、属于哪个名字;读不准返回 null。 */
function tomlTables(text) {
  const stripped = stripTomlNoise(text);
  if (stripped.why) return null;
  const tables = [];
  stripped.lines.forEach((line, i) => {
    const head = HEADER.exec(line.trim());
    if (!head) return;
    const path = tomlKeyPath(head[1]);
    tables.push({ line: i, path, header: head[0] });
  });
  if (tables.some((t) => !t.path)) return null;
  return { lines: stripped.lines, tables };
}

/** TOML:某个名字底下那几张表的正文(去掉注释),用来认它起的是什么。 */
function tomlBody(parsed, name) {
  const out = [];
  parsed.tables.forEach((t, k) => {
    if (t.path[0] !== "mcp_servers" || t.path[1] !== name) return;
    const end = k + 1 < parsed.tables.length ? parsed.tables[k + 1].line : parsed.lines.length;
    out.push(...parsed.lines.slice(t.line, end));
  });
  return out.join("\n");
}

/** TOML 的两种改法:把 name 底下的表头改成 navi,或者把那几张表整段删掉。 */
function editToml(text, parsed, name, mode) {
  const lines = text.split("\n");
  if (lines.length !== parsed.lines.length) return null;
  const drop = new Set();
  parsed.tables.forEach((t, k) => {
    if (t.path[0] !== "mcp_servers" || t.path[1] !== name) return;
    if (mode === "rename") {
      const at = lines[t.line].indexOf(t.header);
      if (at < 0) return;
      const path = ["mcp_servers", NAVI, ...t.path.slice(2)].map((p) => (/^[A-Za-z0-9_-]+$/.test(p) ? p : JSON.stringify(p))).join(".");
      const double = t.header.startsWith("[[");
      lines[t.line] = `${lines[t.line].slice(0, at)}${double ? "[[" : "["}${path}${double ? "]]" : "]"}${lines[t.line].slice(at + t.header.length)}`;
    } else {
      const end = k + 1 < parsed.tables.length ? parsed.tables[k + 1].line : lines.length;
      for (let i = t.line; i < end; i += 1) drop.add(i);
    }
  });
  return lines.filter((_, i) => !drop.has(i)).join("\n");
}

/** 一份来源里还在的旧名条目:{ name, navi(起的是 Navi 脚本), on(开着) }。 */
function legacyIn(text, site) {
  if (site.shape === "toml") {
    const parsed = tomlTables(text);
    const scan = scanTomlServers(text);
    if (!parsed || scan.why) return null;
    const rootOff = scan.rootArrays[site.switches?.off?.[0]] || [];
    return {
      hasNavi: scan.names.includes(NAVI),
      found: LEGACY_NAMES.filter((n) => scan.names.includes(n))
        .map((name) => {
          const body = tomlBody(parsed, name);
          const launch = body.split("\n").filter((l) => /^\s*(command|args)\s*=/.test(l)).map((l) => l.trim()).join(" ");
          const args = (launch.match(/"(?:[^"\\]|\\.)*"|'[^']*'/g) || []).map((q) => unquoteToml(q));
          return { name, launch, navi: pointsAtNaviMcp(launch), on: !rootOff.includes(name), dead: deadScript(args) };
        }),
    };
  }
  const doc = readJsonLoose(text);
  if (doc === undefined) return null;
  const servers = doc?.[site.shape === "opencode" ? "mcp" : "mcpServers"];
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { hasNavi: false, found: [] };
  const launch = (e) => [].concat(e?.command ?? [], e?.args ?? []).join(" ");
  return {
    hasNavi: Object.hasOwn(servers, NAVI),
    found: LEGACY_NAMES.filter((n) => Object.hasOwn(servers, n)).map((name) => ({
      name,
      launch: launch(servers[name]),
      navi: pointsAtNaviMcp(launch(servers[name])),
      on: !!servers[name] && typeof servers[name] === "object" && servers[name].enabled !== false && servers[name].disabled !== true,
      dead: deadScript([].concat(servers[name]?.command ?? [], servers[name]?.args ?? [])),
    })),
  };
}

/** 在一份文本上做改动:先删(已有 navi 的那些),再把剩下的第一条改名。返回新文本或 { why }。 */
function retireIn(text, site, plan) {
  let body = text;
  for (const { name, mode } of plan) {
    if (site.shape === "toml") {
      const parsed = tomlTables(body);
      const next = parsed && editToml(body, parsed, name, mode);
      if (next == null) return { why: "TOML 表头认不准" };
      body = next;
    } else {
      const container = site.shape === "opencode" ? "mcp" : "mcpServers";
      const r = mode === "rename" ? renameJsonMember(body, container, name, NAVI) : removeJsonMember(body, container, name);
      if (!r.body) return { why: r.why };
      body = r.body;
    }
  }
  return { body };
}

/**
 * 收一家。返回 `{ changed:[{ file, removed:[名], renamed:名|null, launch, backup }], foreign:[名], skipped:原因|null }`
 * (launch = 改名那条的启动命令,调用方据此提醒「它起的不是这份检出」)。
 * 一个字节都没写时 changed 为空;skipped 说清为什么没收(看不准、发布没成)。
 */
export function retireLegacyHostMcp({ agentType, env = process.env, home = homedir() }) {
  const site = HOST_SITES[agentType];
  const sources = hostMcpSources(agentType, { env, home });
  const before = effectiveState(sources, site);
  const result = { changed: [], foreign: [], skipped: null };
  const edits = [];
  let naviSomewhere = sources.some((s) => s.file && legacyIn(readForWrite(s.file)?.text ?? "", site)?.hasNavi);
  for (const source of sources) {
    if (!source.file) continue;
    const read = readForWrite(source.file);
    if (!read || read.text === null) continue;
    const seen = legacyIn(read.text, site);
    if (!seen || !seen.found.length) continue;
    result.foreign.push(...seen.found.filter((f) => !f.navi).map((f) => f.name));
    const ours = seen.found.filter((f) => f.navi && f.on);
    if (!ours.length) continue;
    // 这份里(或者别的那份里)已经有 navi:旧名全删;没有:第一条起得来的改名成 navi,其余删。
    let renaming = !(seen.hasNavi || naviSomewhere);
    const plan = ours.map((f) => {
      const mode = renaming && !f.dead ? "rename" : "remove";
      if (mode === "rename") renaming = false;
      return { name: f.name, launch: f.launch, mode };
    });
    if (plan.some((p) => p.mode === "rename")) naviSomewhere = true;
    const edited = retireIn(read.text, site, plan);
    if (!edited.body) return { ...result, skipped: `${source.file}:${edited.why}` };
    edits.push({ source, previous: read.text, body: edited.body, plan });
  }
  result.foreign = [...new Set(result.foreign)];
  if (!edits.length) return result;
  if (before.state === "unsure") return { ...result, skipped: before.why };
  // 合起来看是关着的(比如 gemini 根级 `mcp.excluded` 里点了旧名):改名会替用户把它打开,不动。
  if (before.state === "disabled") return result;

  // 改完的候选上把「最终看到什么」再算一遍:生效的得是 navi,起 Navi 脚本的旧名一条都不剩。
  // 「一条都没了」只在删掉的全是起不来的那种时出现,紧接着的 registerHostMcp 会补上 navi。
  const candidate = sources.map((s) => {
    const e = edits.find((x) => x.source === s);
    return e ? { ...s, file: null, text: e.body } : s;
  });
  const after = effectiveState(candidate, site);
  const stillLegacy = edits.some((e) => legacyIn(e.body, site)?.found.some((f) => f.navi && f.on));
  const settled = (after.state === "present" && after.name === NAVI) || after.state === "absent";
  if (!settled || stillLegacy) {
    return { ...result, skipped: `改完算出来生效的不是 navi(${after.why || after.state}),没写` };
  }
  for (const e of edits) {
    const published = publishConfirmed({ file: e.source.file, previous: e.previous, body: e.body });
    if (!published.ok) return { ...result, skipped: `${e.source.file}:${published.why}` };
    result.changed.push({
      file: e.source.file, backup: published.backup,
      removed: e.plan.filter((p) => p.mode === "remove").map((p) => p.name),
      renamed: e.plan.find((p) => p.mode === "rename")?.name ?? null,
      launch: e.plan.find((p) => p.mode === "rename")?.launch ?? null,
    });
  }
  return result;
}
