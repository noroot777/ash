// 本地目录迁移的清点（下半）：各家执行器按工作目录记的会话、配置目录与配置文件。只读。
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { claudeSlug, CLAUDE_SLUG_MAX, countJsonRefs, countRefs, grokDirName, isUnder, mapPath, rewriteJson } from "./relocate-checkout-paths.mjs";
import { isDirNoFollow, isLink, lexists, listDir, readTextOr, sh } from "./relocate-checkout-fs.mjs";

/**
 * 各家执行器的配置目录，按**此刻**的位置给（树已经搬了的话，树里的那些换算到新位置）：
 * claude —— ~/.claude、CLAUDE_CONFIG_DIR、库里会话登记的 cli_config_dir、个人档 data/user-cli/<人>/claude；
 * codex —— CODEX_HOME（默认 ~/.codex）、库里登记的、个人档 data/user-cli/<人>/codex。
 * 个人档的布局见 server/src/auth/user-cli.ts。
 */
export function agentDirs({ home, env, root, from, to, dbDirs = {}, errors }) {
  const here = (d) => (root === to ? mapPath(d, from, to) ?? d : d);
  const userCli = join(root, "data", "user-cli");
  const personal = (agent) => listDir(userCli, errors).map((u) => join(userCli, u, agent)).filter(isDirNoFollow);
  const uniq = (xs) => [...new Set(xs.filter(Boolean).map((d) => here(resolve(d))))];
  return {
    claude: uniq([join(home, ".claude"), env.CLAUDE_CONFIG_DIR, ...(dbDirs.claude ?? []), ...personal("claude")]),
    codex: uniq([env.CODEX_HOME || join(home, ".codex"), ...(dbDirs.codex ?? []), ...personal("codex")]),
    defaultClaude: join(home, ".claude"),
  };
}

/** 一个 claude 会话目录里的证据：随便几份会话记录里的 cwd，以及顶层会话记录的会话号。 */
function claudeEvidence(dir, errors) {
  const files = listDir(dir, errors).filter((f) => f.endsWith(".jsonl"));
  const sessions = files.map((f) => f.slice(0, -".jsonl".length));
  for (const f of files.slice(0, 4)) {
    const buf = Buffer.alloc(256 * 1024);
    let n = 0;
    try { const fd = openSync(join(dir, f), "r"); n = readSync(fd, buf, 0, buf.length, 0); closeSync(fd); }
    catch (error) { errors.push(`读不了 ${join(dir, f)}（${error.code}）`); continue; }
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.subarray(0, n).toString("utf8"));
    if (m) { try { return { cwd: JSON.parse(`"${m[1]}"`), sessions }; } catch { /* 下一份 */ } }
  }
  return { cwd: null, sessions };
}

/** 两棵目录树能不能合并：同名的子项都是目录就往下比，都是文件且内容相同算不冲突。 */
function mergeConflicts(src, dst, errors, rel = "") {
  const conflicts = [];
  for (const name of listDir(src, errors)) {
    const s = join(src, name);
    const d = join(dst, name);
    if (!lexists(d)) continue;
    const ss = lstatSync(s);
    const ds = lstatSync(d);
    if (ss.isDirectory() && ds.isDirectory()) conflicts.push(...mergeConflicts(s, d, errors, join(rel, name)));
    else if (!(ss.isFile() && ds.isFile() && readFileSync(s).equals(readFileSync(d)))) conflicts.push(join(rel, name));
  }
  return conflicts;
}

/**
 * claude 按工作目录起的会话目录（主仓那个目录里还有长期记忆 memory/）。目录名是有损编码：
 * `/x/harness-old`、`/x/harness/old`、`/x/harness中文` 换出来可以是同一个名字，所以**只凭证据认领**：
 *   ① 目录里会话记录的 cwd 在树里；
 *   ② 子目录名是某个已认领目录里的会话号（子代理、工作流脚本按会话号放在 `<cwd 的目录名>/<会话号>/` 下）；
 *   ③ 名字正好是树里登记过的路径（主仓本身、git 登记的工作区）换出来的；
 *   ④ 用户用 --claude-claim 点名认领。
 * cwd 在树外的是别人的，不动；什么证据都没有的列进 unclassified，不动、拦着拆过渡链接，
 * 等人用 --claude-claim / --claude-skip 定。
 */
export function scanClaude(configDirs, { from, to, knownPaths, claims = {}, errors }) {
  const oldSlug = claudeSlug(from);
  const newSlug = claudeSlug(to);
  const known = new Set([...knownPaths].map(claudeSlug));
  const ours = claims.ours ?? [];
  const skip = claims.skip ?? [];
  const moves = [];
  const unclassified = [];
  for (const configDir of configDirs) {
    const projects = join(configDir, "projects");
    const names = listDir(projects, errors).filter((n) => isDirNoFollow(join(projects, n)));
    const mine = (n, slug) => n === slug || n.startsWith(`${slug}-`);
    const evidence = new Map(names.filter((n) => mine(n, oldSlug) || mine(n, newSlug)).map((n) => [n, claudeEvidence(join(projects, n), errors)]));
    const inTree = (cwd) => isUnder(cwd, from) || isUnder(cwd, to);
    const sessions = new Set([...evidence.values()].filter((e) => e.cwd !== null && inTree(e.cwd)).flatMap((e) => e.sessions));
    for (const name of names) {
      if (!mine(name, oldSlug)) continue;
      const src = join(projects, name);
      const { cwd } = evidence.get(name);
      let why = null;
      if (cwd !== null) {
        if (!inTree(cwd)) continue;
        why = `会话记录的工作目录 ${cwd}`;
      } else {
        const linked = listDir(src, errors).find((s) => sessions.has(s));
        if (linked) why = `会话 ${linked} 的记录在树里`;
        else if (known.has(name)) why = "树里登记过的路径";
        else if (ours.includes(name)) why = "--claude-claim 认领";
        else if (skip.includes(name)) continue;
        else { unclassified.push({ path: src, why: "目录里没有会话记录，也对不上树里的会话或登记过的路径，分不清是哪个目录的" }); continue; }
      }
      const next = `${newSlug}${name.slice(oldSlug.length)}`;
      if (next.length > CLAUDE_SLUG_MAX || name.length > CLAUDE_SLUG_MAX) {
        unclassified.push({ path: src, why: "目录名超过 claude 的长度上限（会截断再拼哈希），没法按前缀换" });
        continue;
      }
      const dst = join(projects, next);
      const merge = lexists(dst);
      moves.push({ configDir, from: src, to: dst, merge, conflicts: merge ? mergeConflicts(src, dst, errors) : [], evidence: why });
    }
  }
  return { moves, unclassified };
}

/**
 * 文本里 `.claude/projects/<目录名>` 换不换：清点时认领了的换成新名；搬过之后（旧名哪里都不在了、
 * 新名在）的也换 —— 核对与重跑时靠这一条认出漏改的引用。其余一律不动。
 */
export function claudeNameMap(configDirs, moves, { from, to }) {
  const oldSlug = claudeSlug(from);
  const newSlug = claudeSlug(to);
  const claimed = new Map(moves.map((m) => [basename(m.from), basename(m.to)]));
  const cache = new Map();
  const anywhere = (n) => configDirs.some((d) => lexists(join(d, "projects", n)));
  return (name) => {
    if (claimed.has(name)) return claimed.get(name);
    if (name !== oldSlug && !name.startsWith(`${oldSlug}-`)) return null;
    if (!cache.has(name)) {
      const next = `${newSlug}${name.slice(oldSlug.length)}`;
      cache.set(name, !anywhere(name) && anywhere(next) ? next : null);
    }
    return cache.get(name);
  };
}

/** 已认领（或已搬过）的 claude 目录里的长期记忆：memory/ 下所有 .md，含子目录。 */
export function memoryFiles(configDirs, { to, errors }) {
  const newSlug = claudeSlug(to);
  const out = [];
  for (const configDir of configDirs) {
    const projects = join(configDir, "projects");
    for (const name of listDir(projects, errors)) {
      if (name !== newSlug && !name.startsWith(`${newSlug}-`)) continue;
      const memory = join(projects, name, "memory");
      for (const f of listDir(memory, errors, { recursive: true })) if (String(f).endsWith(".md")) out.push(join(memory, String(f)));
    }
  }
  return out;
}

/** grok 的会话目录：目录名是 encodeURIComponent(工作目录)，可以精确解回来。 */
export function scanGrok(home, { from, to, errors }) {
  const dir = join(home, ".grok", "sessions");
  const moves = [];
  const odd = [];
  for (const name of listDir(dir, errors)) {
    let decoded;
    try { decoded = decodeURIComponent(name); } catch { continue; }
    const next = mapPath(decoded, from, to);
    if (!next) continue;
    if (grokDirName(decoded) !== name) { odd.push({ path: join(dir, name), why: "目录名不是标准编码，解不回同一个名字" }); continue; }
    const dst = join(dir, grokDirName(next));
    const merge = lexists(dst);
    moves.push({ from: join(dir, name), to: dst, merge, conflicts: merge ? mergeConflicts(join(dir, name), dst, errors) : [] });
  }
  return { dir, moves, odd };
}

/** opencode 的库：会话按 directory 认工作目录，目录不在了续跑直接报错（实测），要改它。 */
export function opencodeDbFile(home, env = process.env) {
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode", "opencode.db");
}

export function scanOpencode(file, { from, to, errors }) {
  if (!existsSync(file)) return { file, missing: true, rows: [] };
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch (error) { errors.push(`打不开 opencode 的库 ${file}（${error.message}）`); return { file, rows: [] }; }
  try {
    const rows = [];
    for (const table of ["session", "workspace"]) {
      const cols = db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
      if (!cols.includes("id") || !cols.includes("directory")) continue;
      for (const r of db.prepare(`SELECT id, directory FROM "${table}" WHERE instr(directory, ?) = 1`).all(from)) {
        const next = mapPath(r.directory, from, to);
        if (next) rows.push({ table, id: r.id, directory: r.directory, next });
      }
    }
    return { file, rows };
  } catch (error) {
    errors.push(`读不了 opencode 的库 ${file}（${error.message}）`);
    return { file, rows: [] };
  } finally {
    db.close();
  }
}

/** 各家 CLI 与 navi 自己的配置文件：MCP 登记（mcp/dist/index.js 的绝对路径）、按路径的项目信任表。 */
export function configFiles(home, env, dirs) {
  const xdg = env.XDG_CONFIG_HOME || join(home, ".config");
  const out = [];
  for (const d of dirs.claude) {
    // 默认位置的 .claude.json 在家目录下；CLAUDE_CONFIG_DIR 指定的目录（含个人档）里它跟着目录走。
    out.push({ file: d === dirs.defaultClaude ? join(home, ".claude.json") : join(d, ".claude.json"), kind: "json" });
    out.push({ file: join(d, "settings.json"), kind: "json" }, { file: join(d, "settings.local.json"), kind: "json" });
  }
  for (const d of dirs.codex) out.push({ file: join(d, "config.toml"), kind: "toml" });
  out.push(
    { file: join(xdg, "opencode", "opencode.json"), kind: "json" },
    { file: join(xdg, "opencode", "opencode.jsonc"), kind: "text" },
    { file: join(home, ".grok", "config.toml"), kind: "toml" },
    { file: join(home, ".gemini", "settings.json"), kind: "json" },
    { file: join(home, ".qwen", "settings.json"), kind: "json" },
    { file: join(home, ".kimi", "config.toml"), kind: "toml" },
    { file: join(home, ".cursor", "mcp.json"), kind: "json" },
  );
  return [...new Map(out.map((c) => [c.file, c])).values()];
}

/** 只报不改的地方：用户自己的 shell 配置、登录项、定时任务。 */
function reportOnlyFiles(home, errors) {
  const files = [".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile", ".config/fish/config.fish"].map((f) => join(home, f));
  const agents = join(home, "Library", "LaunchAgents");
  for (const f of listDir(agents, errors)) if (f.endsWith(".plist")) files.push(join(agents, f));
  return files;
}

/** 一份配置能不能安全改：JSON 键改完撞名、TOML 表头改完重名都不改，拦下真做，交给人定。 */
export function configProblems(text, kind, rules) {
  const problems = [];
  if (kind === "json") {
    let value;
    try { value = JSON.parse(text); } catch { return ["不是合法 JSON"]; }
    const collisions = [];
    rewriteJson(value, rules, collisions);
    for (const c of collisions) problems.push(`${c.at} 下的键 ${c.key} 改完会和已有的 ${c.existing} 重名（两份都有内容，该留哪份、怎么合只有你知道）`);
  }
  if (kind === "toml") {
    const headers = new Set(text.match(/^\s*\[[^\]\n]+\]\s*$/gm)?.map((h) => h.trim()) ?? []);
    for (const h of headers) {
      const next = h.replace(rules[0].re, rules[0].new);
      if (next !== h && headers.has(next)) problems.push(`改完会和已有的 ${next} 重名`);
    }
  }
  return problems;
}

/** 一份配置里有几处要换；JSON 按解析后的键和值数（解析不了的按原文数，好让它作为问题报出来）。 */
export function refsIn(text, kind, rules) {
  if (kind === "json") { try { return countJsonRefs(JSON.parse(text), rules); } catch { /* 下面按原文 */ } }
  return countRefs(text, rules);
}

export function scanConfigs(home, rules, { env, dirs, from, to, errors }) {
  const rewrite = [];
  const relink = [];
  for (const { file, kind } of configFiles(home, env, dirs)) {
    if (!lexists(file)) continue;
    // 配置是链接（dotfiles 仓库里那种）：指着树里的，链接本身要改指；正文改它指着的那一份。
    if (isLink(file)) {
      const target = readlinkSync(file);
      const abs = isAbsolute(target) ? target : resolve(dirname(file), target);
      const next = mapPath(abs, from, to);
      if (next) relink.push({ path: file, target, next: isAbsolute(target) ? next : relative(dirname(file), next) });
    }
    let real;
    try { real = realpathSync(file); } catch (error) { if (!relink.some((r) => r.path === file)) errors.push(`配置 ${file} 是断掉的链接（${error.code}）`); continue; }
    const text = readTextOr(real, errors);
    if (text === null) continue;
    const count = refsIn(text, kind, rules);
    if (!count) continue;
    rewrite.push({ file, real, kind, count, problems: configProblems(text, kind, rules) });
  }
  const reportOnly = [];
  for (const file of reportOnlyFiles(home, errors)) {
    const text = readTextOr(file, errors);
    if (text === null) continue;
    const lines = text.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => countRefs(l, rules));
    if (lines.length) reportOnly.push({ file, lines: lines.slice(0, 8) });
  }
  const cron = sh("crontab", ["-l"], [], { okCodes: [0, 1] });
  if (cron === null) errors.push("读不了 crontab");
  else if (cron.status === 0) {
    const cronLines = cron.stdout.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => countRefs(l, rules));
    if (cronLines.length) reportOnly.push({ file: "crontab -l", lines: cronLines });
  } else if (!/no crontab/i.test(cron.stderr)) errors.push(`读不了 crontab（${cron.stderr.trim().slice(0, 120)}）`);
  return { rewrite, relink, reportOnly };
}
