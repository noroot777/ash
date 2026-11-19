// 本地目录迁移的清点（下半）：各家执行器按工作目录记的会话、配置文件。只读。资源的位置一律来自
// relocate-checkout-roots.mjs 的 resolveRoots（此刻的位置），这里不再自己拼路径。
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { claudeSlug, CLAUDE_SLUG_MAX, countJsonRefs, countRefs, grokDirName, isUnder, literalCollisions, mapPath, rewriteJson, rewriteText } from "./relocate-checkout-paths.mjs";
import { isDirNoFollow, isLink, lexists, listDir, readTextOr, sh } from "./relocate-checkout-fs.mjs";

/** 一份会话记录开头里的 cwd；读不出来返回 null。 */
function sessionCwd(file, errors) {
  const buf = Buffer.alloc(64 * 1024);
  let n = 0;
  try { const fd = openSync(file, "r"); n = readSync(fd, buf, 0, buf.length, 0); closeSync(fd); }
  catch (error) { errors.push(`读不了 ${file}（${error.code}）`); return null; }
  const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.subarray(0, n).toString("utf8"));
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return null; }
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
 * `/x/harness-old`、`/x/harness/old`、`/x/harness--worktrees-T1`（与 `/x/harness/.worktrees/T1` 同名）
 * 换出来可以是同一个名字，所以**名字什么都证明不了，只认能核实的来源**：
 *   ① 目录里每一份会话记录的 cwd 都在树里（有一份在树外就分不清，整目录不动）；
 *   ② 子目录名是一个会话号（子代理、工作流脚本按会话号放在 `<cwd 的目录名>/<会话号>/` 下），而那份
 *      会话记录本身的 cwd 在树里；
 *   ③ 用户用 --claude-claim <完整路径> 点名认领（绑定到具体的配置目录，不按名字 —— 同名的目录在别的
 *      配置目录里可能是别人的）。
 * --claude-skip 点名的（目录名或完整路径）排在最前，什么证据都不看。cwd 全在树外的是别人的，不动；其余列进 unclassified，
 * 不动、拦着核对与拆过渡链接，等人点名。
 */
export function scanClaude(configDirs, { from, to, claims = {}, errors }) {
  const oldSlug = claudeSlug(from);
  const newSlug = claudeSlug(to);
  const ours = claims.ours ?? [];
  const skip = claims.skip ?? [];
  const inTree = (cwd) => isUnder(cwd, from) || isUnder(cwd, to);
  const mine = (n, slug) => n === slug || n.startsWith(`${slug}-`);
  const moves = [];
  const unclassified = [];
  for (const configDir of configDirs) {
    const projects = join(configDir, "projects");
    const names = listDir(projects, errors).filter((n) => (mine(n, oldSlug) || mine(n, newSlug)) && isDirNoFollow(join(projects, n)));
    // 这些目录里每份会话记录的 cwd，按会话号索引（② 要按会话号找回那一份）。
    const cwds = new Map();
    const sessionsOf = new Map();
    for (const n of names) {
      const ids = listDir(join(projects, n), errors).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length));
      sessionsOf.set(n, ids);
      for (const id of ids) cwds.set(id, sessionCwd(join(projects, n, `${id}.jsonl`), errors));
    }
    for (const name of names) {
      const src = join(projects, name);
      if (!mine(name, oldSlug) || skip.includes(name) || skip.includes(src)) continue;
      const seen = sessionsOf.get(name).map((id) => cwds.get(id)).filter((c) => c !== null);
      let why = null;
      if (seen.length) {
        const inside = seen.filter(inTree);
        if (!inside.length) continue; // 全是别人的
        if (inside.length < seen.length) { unclassified.push({ path: src, why: `目录里混着树里和树外（${seen.find((c) => !inTree(c))}）的会话，要手工分开`, claimable: false }); continue; }
        why = `会话记录的工作目录 ${inside[0]}`;
      } else if (ours.includes(src)) {
        why = "--claude-claim 认领";
      } else {
        const linked = listDir(src, errors).find((s) => cwds.has(s) && cwds.get(s) !== null && inTree(cwds.get(s)));
        if (linked) why = `会话 ${linked} 的工作目录 ${cwds.get(linked)}`;
        else { unclassified.push({ path: src, why: "目录里没有会话记录，也不挂在树里的哪个会话下面，分不清是哪个目录的", claimable: true }); continue; }
      }
      const next = `${newSlug}${name.slice(oldSlug.length)}`;
      if (next.length > CLAUDE_SLUG_MAX || name.length > CLAUDE_SLUG_MAX) {
        unclassified.push({ path: src, why: "目录名超过 claude 的长度上限（会截断再拼哈希），没法按前缀换", claimable: false });
        continue;
      }
      const dst = join(projects, next);
      const merge = lexists(dst);
      moves.push({ configDir, from: src, to: dst, merge, conflicts: merge ? mergeConflicts(src, dst, errors) : [], evidence: why });
    }
  }
  return { moves, unclassified };
}

/** 给定的 claude 会话目录（只给有证据认领过的）里的长期记忆：memory/ 下所有 .md，含子目录。 */
export function memoryFiles(dirs, errors) {
  const out = [];
  for (const dir of new Set(dirs)) {
    const memory = join(dir, "memory");
    for (const f of listDir(memory, errors, { recursive: true })) if (String(f).endsWith(".md")) out.push(join(memory, String(f)));
  }
  return out;
}

/** grok 的会话目录：目录名是 encodeURIComponent(工作目录)，可以精确解回来。 */
export function scanGrok(dir, { from, to, errors }) {
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

/** 只报不改的地方：用户自己的 shell 配置、登录项、定时任务。 */
function reportOnlyFiles(home, errors) {
  const files = [".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile", ".config/fish/config.fish"].map((f) => join(home, f));
  const agents = join(home, "Library", "LaunchAgents");
  for (const f of listDir(agents, errors)) if (f.endsWith(".plist")) files.push(join(agents, f));
  return files;
}

let tomlParser;
/** 用 Python 3.11+ 自带的 tomllib 判 TOML 合不合法；本机没有它返回 null（判不了）。 */
export function tomlValid(text) {
  if (tomlParser === undefined) tomlParser = spawnSync("python3", ["-c", "import tomllib"], { stdio: "ignore" }).status === 0;
  if (!tomlParser) return null;
  return spawnSync("python3", ["-c", "import sys, tomllib; tomllib.loads(sys.stdin.read())"], { input: text, stdio: ["pipe", "ignore", "ignore"] }).status === 0;
}

/**
 * 一份配置能不能安全改。JSON 按结构判键撞名；TOML、JSONC 没有解析器可用，按字面量保守地判（见
 * relocate-checkout-paths.mjs 的 literalCollisions），TOML 另外在有 tomllib 时校验改前改后都合法。
 * 有问题就不改、拦下真做，交给人定 —— 哪份该留、怎么合只有人知道。
 */
export function configProblems(text, kind, rules) {
  const problems = [];
  if (kind === "json") {
    let value;
    try { value = JSON.parse(text); } catch { return ["不是合法 JSON"]; }
    const collisions = [];
    rewriteJson(value, rules, collisions);
    for (const c of collisions) problems.push(`${c.at} 下的键 ${c.key} 改完会和已有的 ${c.existing} 重名（两份都有内容，该留哪份、怎么合只有你知道）`);
    return problems;
  }
  for (const c of literalCollisions(text, rules)) problems.push(`字符串 ${c.key} 改完会和已有的 ${c.existing} 相同（可能撞成同一个键）`);
  if (kind === "toml") {
    if (tomlValid(text) === false) problems.push("原文就不是合法 TOML");
    else if (tomlValid(rewriteText(text, rules).text) === false) problems.push("改完不是合法 TOML");
  }
  return problems;
}

/** 一份配置里有几处要换；JSON 按解析后的键和值数（解析不了的按原文数，好让它作为问题报出来）。 */
export function refsIn(text, kind, rules) {
  if (kind === "json") { try { return countJsonRefs(JSON.parse(text), rules); } catch { /* 下面按原文 */ } }
  return countRefs(text, rules);
}

export function scanConfigs(home, rules, { files, from, to, errors }) {
  const rewrite = [];
  const relink = [];
  for (const { file, kind } of files) {
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
