// 本地目录迁移的清点：只读，不改任何东西。演练（默认）打印它，真做（--apply）照它做，
// 核对（--verify）拿它看还剩什么。每一项都按「此刻磁盘上的样子」现算，所以搬到一半中断之后
// 再跑一遍，算出来的就是还没做完的那部分（脚本可重复执行靠的就是这一点）。
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, openSync, readFileSync, readSync, closeSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LEGACY_DB_FILE, LEGACY_REPO_DIR_NAMES, LEGACY_SINGLETON_LOCK_SUFFIX } from "./legacy-names.mjs";
import { claudeSlug, CLAUDE_SLUG_MAX, countRefs, grokDirName, isUnder, mapPath, rewriteRules, rewriteText } from "./relocate-checkout-paths.mjs";

const isDirNoFollow = (p) => { try { return lstatSync(p).isDirectory(); } catch { return false; } };
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const readText = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const sh = (cmd, args, opts = {}) => {
  try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024, ...opts }); }
  catch (error) { return opts.allowFail ? (error.stdout ?? "") : null; }
};

/** 目录树此刻在哪：旧位置是真目录 → 还没搬；旧位置没了或是指向新位置的链接、新位置是真目录 → 已搬。 */
export function locateTree({ from, to }) {
  const fromDir = isDirNoFollow(from);
  const toDir = isDirNoFollow(to);
  const fromLink = isLink(from);
  const linkTarget = fromLink ? resolve(dirname(from), readlinkSync(from)) : null;
  if (fromDir && !toDir && !existsSync(to) && !isLink(to)) return { state: "pending", root: from };
  if (fromDir && (toDir || existsSync(to) || isLink(to))) return { state: "conflict", root: from, why: `${to} 已经存在，不会覆盖` };
  if (toDir && (!existsSync(from) && !fromLink)) return { state: "moved", root: to, link: "absent" };
  if (toDir && fromLink) {
    return linkTarget === to
      ? { state: "moved", root: to, link: "ours" }
      : { state: "conflict", root: to, why: `${from} 是指向 ${linkTarget} 的链接，不是指向 ${to}` };
  }
  return { state: "missing", root: null, why: `${from} 和 ${to} 都不是目录` };
}

/** 库文件：显式给的优先；否则数据目录里 navi.db 在就用它，不然用旧库名（与 scripts/server-control.mjs 同口径）。 */
export function dbFileIn(root, explicit) {
  if (explicit) return resolve(explicit);
  const navi = join(root, "data", "navi.db");
  return existsSync(navi) ? navi : join(root, "data", LEGACY_DB_FILE);
}

/** 库里每个文本列还有几处旧路径。只读打开，不碰 -wal（服务停着时本来就没有）。 */
export function scanDb(dbFile, rules) {
  if (!existsSync(dbFile)) return { file: dbFile, missing: true, refs: [], total: 0 };
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const refs = [];
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    for (const { name: table } of tables) {
      for (const { name: column } of db.prepare(`PRAGMA table_info("${table}")`).all()) {
        const probe = rules.map(() => `instr("${column}", ?) > 0`).join(" OR ");
        const rows = db.prepare(`SELECT "${column}" AS v FROM "${table}" WHERE typeof("${column}") = 'text' AND (${probe})`)
          .all(...rules.map((r) => r.old));
        let count = 0;
        for (const { v } of rows) count += countRefs(v, rules);
        if (count) refs.push({ table, column, rows: rows.length, count });
      }
    }
    return { file: dbFile, refs, total: refs.reduce((n, r) => n + r.count, 0) };
  } finally {
    db.close();
  }
}

/** 库里登记的、跟这棵树有关的东西：在跑的任务、在盯的哨兵、claude 的配置目录。 */
export function scanDbState(dbFile) {
  const out = { running: [], monitors: [], claudeConfigDirs: [] };
  if (!existsSync(dbFile)) return out;
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  try {
    if (has("tasks")) out.running = db.prepare("SELECT id, title, status FROM tasks WHERE status IN ('running','queued')").all();
    if (has("monitors")) out.monitors = db.prepare("SELECT id, task_id AS taskId FROM monitors WHERE status = 'running'").all();
    if (has("sessions")) {
      const cols = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
      if (cols.includes("cli_config_dir")) {
        out.claudeConfigDirs = db.prepare("SELECT DISTINCT cli_config_dir AS d FROM sessions WHERE agent_type = 'claude' AND cli_config_dir IS NOT NULL AND cli_config_dir <> ''")
          .all().map((r) => r.d);
      }
    }
  } finally {
    db.close();
  }
  return out;
}

/** 服务还开着这份库吗：单例锁里的进程活着、或者有进程开着库文件。 */
export function scanService(dbFile) {
  const reasons = [];
  for (const suffix of [".navi.lock", LEGACY_SINGLETON_LOCK_SUFFIX]) {
    const lock = `${dbFile}${suffix}`;
    const text = readText(lock);
    if (text === null) continue;
    let pid = null;
    try { pid = JSON.parse(text).pid; } catch { /* 读不懂的锁按活着算 */ }
    if (!Number.isInteger(pid)) { reasons.push(`单例锁 ${lock} 读不懂，按服务仍在运行处理`); continue; }
    try { process.kill(pid, 0); reasons.push(`单例锁 ${lock} 的持有进程 ${pid} 还活着`); }
    catch (error) { if (error.code === "EPERM") reasons.push(`单例锁 ${lock} 的持有进程 ${pid} 还活着`); }
  }
  if (existsSync(dbFile)) {
    const out = sh("lsof", ["-Fpc", "--", dbFile], { allowFail: true }) ?? "";
    for (const pid of out.split("\n").filter((l) => l.startsWith("p")).map((l) => Number(l.slice(1)))) {
      if (pid !== process.pid) reasons.push(`进程 ${pid} 开着库文件 ${dbFile}`);
    }
  }
  return { running: reasons.length > 0, reasons };
}

function ancestors() {
  const out = new Set([process.pid]);
  let pid = process.ppid;
  for (let i = 0; i < 64 && pid > 1 && !out.has(pid); i += 1) {
    out.add(pid);
    const next = Number((sh("ps", ["-o", "ppid=", "-p", String(pid)]) ?? "").trim());
    if (!Number.isInteger(next)) break;
    pid = next;
  }
  return out;
}

const SHELLS = new Set(["zsh", "-zsh", "bash", "-bash", "sh", "fish", "-fish", "login"]);

/**
 * 工作目录在树里的进程会拦下真做：agent、哨兵、预览、构建……搬目录时它们手里的路径全会失效。
 * 例外是本脚本和它的祖先，以及纯交互 shell（搬完它们的 `$PWD` 只是显示旧路径，留着链接时照样能用）。
 * 命令行里带旧路径、但工作目录不在树里的（别的会话拉起的 navi MCP）只提示：它们已经把文件读进内存，
 * 留着链接时新起的也找得到。
 */
export function scanProcesses(roots) {
  const self = ancestors();
  const blocking = [];
  const shells = [];
  const argvRefs = [];
  const lsof = sh("lsof", ["-a", "-d", "cwd", "-FpRcn"], { allowFail: true }) ?? "";
  let cur = null;
  for (const line of lsof.split("\n")) {
    if (line.startsWith("p")) cur = { pid: Number(line.slice(1)) };
    else if (line.startsWith("R") && cur) cur.ppid = Number(line.slice(1));
    else if (line.startsWith("c") && cur) cur.command = line.slice(1);
    else if (line.startsWith("n") && cur) {
      cur.cwd = line.slice(1);
      // 本脚本自己拉起的 lsof / ps / find 也站在这里，不算。
      const ours = self.has(cur.pid) || cur.ppid === process.pid;
      if (!ours && roots.some((r) => isUnder(cur.cwd, r))) (SHELLS.has(cur.command) ? shells : blocking).push({ pid: cur.pid, command: cur.command, cwd: cur.cwd });
    }
  }
  const ps = sh("ps", ["-axww", "-o", "pid=,command="]) ?? "";
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || self.has(Number(m[1]))) continue;
    if (roots.some((r) => m[2].includes(r + sep) || m[2].endsWith(r)) && !blocking.some((p) => p.pid === Number(m[1]))) {
      argvRefs.push({ pid: Number(m[1]), command: m[2].slice(0, 160) });
    }
  }
  return { blocking, shells, argvRefs };
}

/**
 * git 工作区的两头：仓库里 `.git/worktrees/<名>/gitdir` 记着工作区的 `.git` 在哪，工作区里的 `.git`
 * 文件记着 `gitdir: <仓库>/.git/worktrees/<名>`。两头都是绝对路径，搬完都要换（等价于
 * `git worktree repair`，只是直接改这两份文件，好记账、好退回）。树里的嵌套仓库、登记在树外的工作区、
 * 树里那些属于树外仓库的工作区都算。返回此刻的文件位置和要换成的内容。
 */
export function scanWorktrees(root, { from, to }) {
  const pathRule = rewriteRules({ from, to }).filter((r) => r.kind === "path");
  const find = (args) => (sh("find", [root, "-name", "node_modules", "-prune", "-o", ...args, "-print"]) ?? "").split("\n").filter(Boolean);
  const now = (p) => (root === to ? mapPath(p, from, to) ?? p : p);
  const adminFiles = new Set();
  const dotGitFiles = new Set(find(["-type", "f", "-name", ".git"]));
  const items = [];
  for (const admin of find(["-type", "d", "-path", "*/.git/worktrees"])) {
    let names = [];
    try { names = readdirSync(admin); } catch { continue; }
    for (const name of names) adminFiles.add(join(admin, name, "gitdir"));
  }
  for (const file of [...dotGitFiles]) {
    const target = /^gitdir:\s*(.+)$/m.exec(readText(file) ?? "")?.[1]?.trim();
    if (target && isAbsolute(target)) adminFiles.add(join(now(target), "gitdir"));
  }
  for (const file of adminFiles) {
    const recorded = readText(file)?.trim();
    if (!recorded || !isAbsolute(recorded)) continue;
    const dotGit = now(recorded);
    const missing = !existsSync(dotGit);
    if (!missing) dotGitFiles.add(dotGit);
    items.push({ admin: dirname(file), worktree: mapPath(dirname(recorded), from, to) ?? dirname(recorded), missing });
  }
  const edits = [];
  for (const file of [...adminFiles, ...dotGitFiles]) {
    const text = readText(file);
    if (text === null) continue;
    const { text: next, count } = rewriteText(text, pathRule);
    if (count) edits.push({ file, text, next });
  }
  return { items, edits };
}

/** 树里指向旧根的绝对链接（工作区借主仓 node_modules 的那批都是）；以及跨出树、换了上级目录会断的相对链接。 */
export function scanSymlinks(root, { from, to }) {
  const out = (sh("find", [root, "-type", "l", "-print0"]) ?? "").split("\0").filter(Boolean);
  const retarget = [];
  const escaping = [];
  for (const path of out) {
    let target;
    try { target = readlinkSync(path); } catch { continue; }
    if (isAbsolute(target)) {
      const next = mapPath(target, from, to);
      if (next) retarget.push({ path, target, next });
    } else if (dirname(from) !== dirname(to)) {
      const resolved = resolve(dirname(path), target);
      if (!isUnder(resolved, root)) escaping.push({ path, target });
    }
  }
  return { retarget, escaping };
}

/** 读一个 claude 会话目录里随便几份记录的 cwd，用来认「这个目录名是不是这棵树的」。 */
function claudeEvidence(dir) {
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).slice(0, 4); } catch { return null; }
  for (const f of files) {
    const buf = Buffer.alloc(256 * 1024);
    let n = 0;
    try { const fd = openSync(join(dir, f), "r"); n = readSync(fd, buf, 0, buf.length, 0); closeSync(fd); } catch { continue; }
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.subarray(0, n).toString("utf8"));
    if (m) { try { return JSON.parse(`"${m[1]}"`); } catch { /* 下一份 */ } }
  }
  return null;
}

/** 两棵目录树能不能合并：同名的子项都是目录就往下比，都是文件且内容相同算不冲突。 */
function mergeConflicts(src, dst, rel = "") {
  const conflicts = [];
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dst, name);
    if (!existsSync(d) && !isLink(d)) continue;
    const ss = lstatSync(s);
    const ds = lstatSync(d);
    if (ss.isDirectory() && ds.isDirectory()) conflicts.push(...mergeConflicts(s, d, join(rel, name)));
    else if (!(ss.isFile() && ds.isFile() && readFileSync(s).equals(readFileSync(d)))) conflicts.push(join(rel, name));
  }
  return conflicts;
}

/**
 * claude 按工作目录起的会话目录（以及主仓那个目录里的长期记忆 memory/）。目录名是有损的：
 * `/x/harness-old` 和 `/x/harness/old` 都叫 `-x-harness-old`，所以除了主目录本身，都要拿目录里
 * 会话记录的 cwd，或者「这条路径确实在树里」来认，认不出的不动、列出来。
 */
export function scanClaude(configDirs, { from, to, knownPaths }) {
  const oldSlug = claudeSlug(from);
  const newSlug = claudeSlug(to);
  const known = new Map([...knownPaths].map((p) => [claudeSlug(p), p]));
  // 没有会话记录可认的目录（子代理/工作流的脚本目录）：`<旧名>--…` 只能来自树里的 `/.xxx`；
  // 其余的只要旁边没有名字以旧根开头的兄弟目录（`harness-old`、`harness.bak`），也只能是树里的。
  let siblings = [];
  try { siblings = readdirSync(dirname(from)).filter((n) => n !== basename(from) && claudeSlug(n).startsWith(`${claudeSlug(basename(from))}-`)); } catch { /* 上级目录读不了就当有歧义 */ siblings = [null]; }
  const byName = (name) => name === oldSlug || known.has(name) || name.startsWith(`${oldSlug}--`) || siblings.length === 0;
  const moves = [];
  const unclassified = [];
  for (const configDir of configDirs) {
    const projects = join(configDir, "projects");
    let names = [];
    try { names = readdirSync(projects); } catch { continue; }
    for (const name of names) {
      if (name !== oldSlug && !name.startsWith(`${oldSlug}-`)) continue;
      const src = join(projects, name);
      if (!isDirNoFollow(src)) continue;
      const cwd = claudeEvidence(src);
      const ours = cwd !== null ? isUnder(cwd, from) || isUnder(cwd, to) : byName(name);
      if (!ours) {
        if (cwd === null) unclassified.push({ path: src, why: `目录里没有会话记录可认，旁边又有 ${siblings.filter(Boolean).join("、") || "读不了的上级目录"}，分不清是哪一个的` });
        continue;
      }
      const next = `${newSlug}${name.slice(oldSlug.length)}`;
      if (next.length > CLAUDE_SLUG_MAX || name.length > CLAUDE_SLUG_MAX) {
        unclassified.push({ path: src, why: "目录名超过 claude 的长度上限（会截断再拼哈希），没法按前缀换" });
        continue;
      }
      const dst = join(projects, next);
      const merge = existsSync(dst);
      moves.push({ configDir, from: src, to: dst, merge, conflicts: merge ? mergeConflicts(src, dst) : [], evidence: cwd ?? "（按目录名认）" });
    }
  }
  return { moves, unclassified };
}

/** grok 的会话目录：目录名是 encodeURIComponent(工作目录)，可以精确解回来。 */
export function scanGrok(home, { from, to }) {
  const dir = join(home, ".grok", "sessions");
  const moves = [];
  const odd = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return { dir, moves, odd }; }
  for (const name of names) {
    let decoded;
    try { decoded = decodeURIComponent(name); } catch { continue; }
    const next = mapPath(decoded, from, to);
    if (!next) continue;
    if (grokDirName(decoded) !== name) { odd.push({ path: join(dir, name), why: "目录名不是标准编码，解不回同一个名字" }); continue; }
    const dst = join(dir, grokDirName(next));
    moves.push({ from: join(dir, name), to: dst, merge: existsSync(dst), conflicts: existsSync(dst) ? mergeConflicts(join(dir, name), dst) : [] });
  }
  return { dir, moves, odd };
}

/** opencode 的库：会话按 directory 认工作目录，目录不在了续跑直接报错（实测），要改它。 */
export function opencodeDbFile(home, env = process.env) {
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode", "opencode.db");
}

export function scanOpencode(file, { from, to }) {
  if (!existsSync(file)) return { file, missing: true, rows: [] };
  const db = new DatabaseSync(file, { readOnly: true });
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
  } finally {
    db.close();
  }
}

/** 各家 CLI 与 navi 自己的配置文件：MCP 登记（mcp/dist/index.js 的绝对路径）、按路径的项目信任表。 */
export function configFiles(home, env = process.env) {
  const xdg = env.XDG_CONFIG_HOME || join(home, ".config");
  return [
    { file: join(home, ".claude.json"), kind: "json" },
    { file: join(home, ".claude", "settings.json"), kind: "json" },
    { file: join(home, ".claude", "settings.local.json"), kind: "json" },
    { file: join(env.CODEX_HOME || join(home, ".codex"), "config.toml"), kind: "toml" },
    { file: join(xdg, "opencode", "opencode.json"), kind: "json" },
    { file: join(xdg, "opencode", "opencode.jsonc"), kind: "text" },
    { file: join(home, ".grok", "config.toml"), kind: "toml" },
    { file: join(home, ".gemini", "settings.json"), kind: "json" },
    { file: join(home, ".qwen", "settings.json"), kind: "json" },
    { file: join(home, ".kimi", "config.toml"), kind: "toml" },
    { file: join(home, ".cursor", "mcp.json"), kind: "json" },
  ];
}

/** 只报不改的地方：用户自己的 shell 配置、登录项、定时任务。 */
export function reportOnlyFiles(home) {
  const files = [".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile", ".config/fish/config.fish"].map((f) => join(home, f));
  const agents = join(home, "Library", "LaunchAgents");
  try { for (const f of readdirSync(agents)) if (f.endsWith(".plist")) files.push(join(agents, f)); } catch { /* 不是 macOS */ }
  return files;
}

export function scanConfigs(home, rules, env = process.env) {
  const rewrite = [];
  for (const { file, kind } of configFiles(home, env)) {
    const text = readText(file);
    if (text === null) continue;
    const count = countRefs(text, rules);
    if (!count) continue;
    const problems = [];
    if (kind === "json") { try { JSON.parse(text); } catch { problems.push("不是合法 JSON，不改"); } }
    if (kind === "toml") {
      // 表头换完跟已有的表头同名，codex 会整份配置读不起来。
      const headers = new Set(text.match(/^\s*\[[^\]\n]+\]\s*$/gm)?.map((h) => h.trim()) ?? []);
      for (const h of headers) {
        const next = h.replace(rules[0].re, rules[0].new);
        if (next !== h && headers.has(next)) problems.push(`改完会和已有的 ${next} 重名`);
      }
    }
    rewrite.push({ file, kind, count, problems });
  }
  const reportOnly = [];
  for (const file of reportOnlyFiles(home)) {
    const text = readText(file);
    if (text === null) continue;
    const lines = text.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => countRefs(l, rules));
    if (lines.length) reportOnly.push({ file, lines: lines.slice(0, 8) });
  }
  const cron = sh("crontab", ["-l"], { allowFail: true }) ?? "";
  const cronLines = cron.split("\n").filter((l) => countRefs(l, rules));
  if (cronLines.length) reportOnly.push({ file: "crontab -l", lines: cronLines.map((l, i) => [i + 1, l]) });
  return { rewrite, reportOnly };
}

/** 数据目录里按路径做键的小文件（技能校准按「执行器 + 工作目录」记）。 */
export function scanDataFiles(root, rules) {
  const out = [];
  for (const name of ["skill-calibrations.json"]) {
    const file = join(root, "data", name);
    const text = readText(file);
    if (text === null) continue;
    const count = countRefs(text, rules);
    if (count) out.push({ file, count });
  }
  return out;
}

/** 远端：仓库在 GitHub 上改名之后要换的地址。 */
export function scanRemote(root) {
  const url = (sh("git", ["-C", root, "remote", "get-url", "origin"]) ?? "").trim() || null;
  const m = url && new RegExp(`^(.*github\\.com[:/][^/]+\\/)(?:${LEGACY_REPO_DIR_NAMES.join("|")})(\\.git)?$`).exec(url);
  return { url, suggested: m ? `${m[1]}navi${m[2] ?? ""}` : null };
}

/** 整份清点。 */
export function scan({ from, to, home, db: dbExplicit, env = process.env }) {
  const where = locateTree({ from, to });
  const rules = rewriteRules({ from, to, home });
  const plan = { from, to, home, where, rules };
  const roots = [from, to];
  if (!where.root) return plan;
  const root = where.root;
  const sameDevice = (() => { try { return statSync(root).dev === statSync(dirname(to)).dev; } catch { return false; } })();
  plan.sameDevice = sameDevice;
  plan.dbFile = dbFileIn(root, dbExplicit);
  plan.db = scanDb(plan.dbFile, rules);
  plan.dbState = scanDbState(plan.dbFile);
  plan.service = scanService(plan.dbFile);
  plan.processes = scanProcesses(roots);
  plan.worktrees = scanWorktrees(root, { from, to });
  plan.symlinks = scanSymlinks(root, { from, to });
  const knownPaths = new Set([from, ...plan.worktrees.items.map((w) => mapPath(w.worktree, to, from) ?? w.worktree)]);
  const claudeDirs = [...new Set([join(home, ".claude"), ...plan.dbState.claudeConfigDirs.map((d) => resolve(d))])];
  plan.claude = scanClaude(claudeDirs, { from, to, knownPaths });
  plan.memoryDirs = claudeDirs.map((d) => join(d, "projects", claudeSlug(to), "memory"));
  plan.grok = scanGrok(home, { from, to });
  plan.opencode = scanOpencode(opencodeDbFile(home, env), { from, to });
  plan.configs = scanConfigs(home, rules, env);
  plan.dataFiles = scanDataFiles(root, rules);
  plan.remote = scanRemote(root);
  try { plan.realFrom = realpathSync(dirname(from)) === dirname(from); } catch { plan.realFrom = false; }
  return plan;
}
