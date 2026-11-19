// 改名之前留在各家 CLI 用户配置里的旧名登记(`ash`、更早的 `harness`)收成 navi —— claude / codex 之外的那十几家。
//
// 为什么要收:旧名那条起的是同一个 Navi MCP 脚本。navi 已经在时它还留着,这家 CLI 每一回合就挂两套一模一样的工具;
// 只有旧名时它能用,但名字跟 Navi 注入、文档、排查口径都对不上。所以:
//   · 这份配置里已经有 navi(或者别的那份里有)⇒ 旧名那条删掉;
//   · 还没有 navi ⇒ 旧名那条**原地改名**成 navi —— 值一个字节都不动(用户调过的开关、环境变量、工具审批都在),
//     注释、键序、别的登记也都原样(json-edit.mjs 的无损改法;TOML 只改表头);
//   · 旧名那条起的脚本已经不在磁盘上了(指着早删掉的 worktree)⇒ 改名也起不来,直接删掉,
//     紧接着 registerHostMcp 按这份检出补一条 navi;
//   · 起的不是 Navi 的 MCP 脚本(同名的别的东西)、或者认不准它起的是什么 ⇒ 不动,报一句;
//   · 关着的不动(条目自己关的、被根级名单挡掉的,口径就是 effectiveState 用的那份 scanSource):改它反而可能替用户把开关拨了;
//   · 只在环境变量里的那份(OPENCODE_CONFIG_CONTENT)改不了,报一句。
// 「起的是什么」只看这条登记**自己**的 command / args(TOML 按表的作用域完整解析,toml-values.mjs):子表、环境变量里
// 碰巧出现的 Navi 路径不算。写之前在**改完的候选**上再验一遍:生效的是 navi(或者一条都没了、马上由 registerHostMcp 补),
// 计划之外的每一条登记都原样在、起的东西没变,计划删的那几条确实没了。验不过一律不写。
// 写盘走 config-publish.mjs 的发布事务(只替换读到的那一版、留备份、读回来比对)。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { publishConfirmed, readForWrite } from "./config-publish.mjs";
import { pointsAtNaviMcp } from "./codex-mcp.mjs";
import { readJsonLoose, removeJsonMember, renameJsonMember } from "./json-edit.mjs";
import { HOST_SITES, LEGACY_NAMES, NAVI, effectiveState, hostMcpSources, scanSource } from "./mcp-host-sources.mjs";
import { scanTomlServers, stripTomlNoise, tomlKeyPath } from "./toml-scan.mjs";
import { tomlTableValues } from "./toml-values.mjs";

const HEADER = /^\[\[?((?:[^\]"']|"(?:[^"\\]|\\.)*"|'[^']*')*)\]\]?/;

/** 启动命令里那个 Navi MCP 脚本是绝对路径、而且已经不在了 ⇒ 这条登记起不来。 */
const deadScript = (launch) => launch.some((a) => pointsAtNaviMcp(a) && /index\.js$/.test(a) && isAbsolute(a) && !existsSync(a));

/**
 * 一份配置文本里登记的每个名字:{ name → { launch: string[] | null(认不准), on } }。整份读不准返回 null。
 * on 跟 effectiveState 同一份判据(scanSource),TOML 再认一下表里的 `enabled = false`。
 */
function serversIn(text, site) {
  const facts = scanSource({ file: null, text }, site);
  if (facts.doubt) return null;
  const on = (name) => facts.names.get(name)?.status === "on";
  const out = new Map();
  if (site.shape === "toml") {
    const scan = scanTomlServers(text);
    if (scan.why) return null;
    for (const name of scan.names) {
      const values = tomlTableValues(text, ["mcp_servers", name]);
      const launch = values && [].concat(values.command ?? [], values.args ?? []);
      out.set(name, {
        launch: launch && launch.every((a) => typeof a === "string") ? launch : null,
        on: on(name) && values?.enabled !== "false",
      });
    }
    return out;
  }
  const doc = readJsonLoose(text);
  const servers = doc?.[site.shape === "opencode" ? "mcp" : "mcpServers"];
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return out;
  for (const [name, entry] of Object.entries(servers)) {
    const launch = entry && typeof entry === "object" ? [].concat(entry.command ?? [], entry.args ?? []) : null;
    out.set(name, { launch: launch && launch.every((a) => typeof a === "string") ? launch : null, on: on(name) });
  }
  return out;
}

/** 旧名条目逐条归类:ours(开着、起的是 Navi 脚本) / off / foreign / unsure(起的是什么认不准)。 */
function legacyIn(servers) {
  return LEGACY_NAMES.filter((n) => servers.has(n)).map((name) => {
    const { launch, on } = servers.get(name);
    const kind = launch === null ? "unsure" : !launch.some(pointsAtNaviMcp) ? "foreign" : on ? "ours" : "off";
    return { name, launch, kind, dead: kind === "ours" && deadScript(launch) };
  });
}

/** TOML 里各个 `[mcp_servers.<名>…]` 表头在第几行;读不准返回 null。 */
function tomlTables(text) {
  const stripped = stripTomlNoise(text);
  if (stripped.why) return null;
  const tables = [];
  stripped.lines.forEach((line, i) => {
    const head = HEADER.exec(line.trim());
    if (head) tables.push({ line: i, path: tomlKeyPath(head[1]), header: head[0] });
  });
  return tables.some((t) => !t.path) ? null : { lines: stripped.lines, tables };
}

/** TOML 的两种改法:把 name 底下的表头改成 navi,或者把那几张表整段删掉。 */
function editToml(text, name, mode) {
  const parsed = tomlTables(text);
  const lines = text.split("\n");
  if (!parsed || lines.length !== parsed.lines.length) return null;
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

/** 按计划改一份文本:返回新文本或 { why }。 */
function retireIn(text, site, plan) {
  let body = text;
  for (const { name, mode } of plan) {
    if (site.shape === "toml") {
      const next = editToml(body, name, mode);
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

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 改完的这份是不是正好只动了计划里那几条:别的名字一个不少、起的东西不变;删的没了;改名的那条换了名字、起的东西不变。 */
function onlyPlanned(before, after, plan) {
  if (!after) return "改完读不通了";
  const planned = new Map(plan.map((p) => [p.name, p]));
  for (const [name, entry] of before) {
    const p = planned.get(name);
    if (!p) { if (!after.has(name) || !same(after.get(name), entry)) return `改完 ${name} 这条变了`; continue; }
    if (after.has(name)) return `改完 ${name} 还在`;
    if (p.mode === "rename" && !same(after.get(NAVI)?.launch, entry.launch)) return "改名之后那条起的东西变了";
  }
  const extra = [...after.keys()].filter((n) => !before.has(n) && !(n === NAVI && plan.some((p) => p.mode === "rename")));
  return extra.length ? `改完多出了 ${extra.join("、")}` : null;
}

/**
 * 收一家。返回 `{ changed:[{ file, removed:[名], renamed:名|null, launch, backup }], foreign:[名], unsure:[名], readonly:[来源],
 * skipped:原因|null }`(launch = 改名那条的启动命令,调用方据此提醒「它起的不是这份检出」)。
 * 一个字节都没写时 changed 为空;skipped 说清为什么没收(看不准、验不过、发布没成)。
 */
export function retireLegacyHostMcp({ agentType, env = process.env, home = homedir() }) {
  const site = HOST_SITES[agentType];
  const sources = hostMcpSources(agentType, { env, home });
  const result = { changed: [], foreign: [], unsure: [], readonly: [], skipped: null };
  const texts = sources.map((s) => (s.file ? readForWrite(s.file)?.text ?? null : s.text ?? null));
  const seen = texts.map((t) => (t === null ? null : serversIn(t, site)));
  let naviSomewhere = seen.some((m) => m?.has(NAVI));
  const edits = [];
  sources.forEach((source, i) => {
    if (!seen[i]) return;
    const found = legacyIn(seen[i]);
    result.foreign.push(...found.filter((f) => f.kind === "foreign").map((f) => f.name));
    result.unsure.push(...found.filter((f) => f.kind === "unsure").map((f) => f.name));
    const ours = found.filter((f) => f.kind === "ours");
    if (!ours.length) return;
    if (!source.file) { result.readonly.push(source.label); return; }
    // 已经有 navi(这份或别的那份):旧名全删;没有:第一条起得来的改名成 navi,其余删。
    let renaming = !naviSomewhere;
    const plan = ours.map((f) => {
      const mode = renaming && !f.dead ? "rename" : "remove";
      if (mode === "rename") renaming = false;
      return { name: f.name, launch: f.launch, mode };
    });
    if (plan.some((p) => p.mode === "rename")) naviSomewhere = true;
    edits.push({ source, previous: texts[i], before: seen[i], plan });
  });
  result.foreign = [...new Set(result.foreign)];
  result.unsure = [...new Set(result.unsure)];
  if (!edits.length) return result;
  const before = effectiveState(sources, site);
  if (before.state === "unsure") return { ...result, skipped: before.why };
  // 合起来看是关着的(根级名单挡掉了之类):改名会替用户把它打开,不动。
  if (before.state === "disabled") return result;

  for (const e of edits) {
    const edited = retireIn(e.previous, site, e.plan);
    if (!edited.body) return { ...result, skipped: `${e.source.file}:${edited.why}` };
    const wrong = onlyPlanned(e.before, serversIn(edited.body, site), e.plan);
    if (wrong) return { ...result, skipped: `${e.source.file}:${wrong},没写` };
    e.body = edited.body;
  }
  // 改完合起来看:生效的得是 navi;「一条都没了」只在删掉的全是起不来的那种时出现,紧接着的 registerHostMcp 会补上。
  const after = effectiveState(sources.map((s) => {
    const e = edits.find((x) => x.source === s);
    return e ? { ...s, file: null, text: e.body } : s;
  }), site);
  if (!((after.state === "present" && after.name === NAVI) || after.state === "absent")) {
    return { ...result, skipped: `改完算出来生效的不是 navi(${after.why || after.state}),没写` };
  }
  for (const e of edits) {
    const published = publishConfirmed({ file: e.source.file, previous: e.previous, body: e.body });
    if (!published.ok) return { ...result, skipped: `${e.source.file}:${published.why}` };
    const renamed = e.plan.find((p) => p.mode === "rename");
    result.changed.push({
      file: e.source.file, backup: published.backup,
      removed: e.plan.filter((p) => p.mode === "remove").map((p) => p.name),
      renamed: renamed?.name ?? null, launch: renamed ? renamed.launch.join(" ") : null,
    });
  }
  return result;
}
