// 本地目录迁移的清点：只读，不改任何东西。演练（默认）打印它，真做（--apply）照它做，
// 核对（--verify）拿它看还剩什么。每一项都按「此刻磁盘上的样子」现算，所以搬到一半中断之后
// 再跑一遍，算出来的就是还没做完的那部分（脚本可重复执行靠的就是这一点）。
//
// 读不到的东西不当成「没有」：命令失败、目录列不了、锁文件读不动都记进 plan.errors，
// 有一条就不许真做、核对不算干净（见 relocate-checkout-fs.mjs 顶部）。
import { readlinkSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LEGACY_REPO_DIR_NAMES } from "./legacy-names.mjs";
import { scanConfigs } from "./relocate-checkout-agents.mjs";
import { analyzeConfig, configStrings } from "./relocate-checkout-config.mjs";
import { isDirNoFollow, isLink, lexists, listDir, readTextOr, sh } from "./relocate-checkout-fs.mjs";
import { Journal } from "./relocate-checkout-journal.mjs";
import { liveHolders } from "./relocate-checkout-lock.mjs";
import { memoryFiles, scanClaude, scanGrok, scanOpencode } from "./relocate-checkout-sessions.mjs";
import { countAmbiguous, countRefs, isUnder, mapPath, otherDirSuffix, rewriteRules } from "./relocate-checkout-paths.mjs";
import { afterPath, claudePrefixes, currentPath, resolveRoots, staleEnv } from "./relocate-checkout-roots.mjs";

/** 目录树此刻在哪：旧位置是真目录 → 还没搬；旧位置没了或是指向新位置的链接、新位置是真目录 → 已搬。 */
export function locateTree({ from, to }) {
  const fromDir = isDirNoFollow(from);
  const toDir = isDirNoFollow(to);
  const fromLink = isLink(from);
  const linkTarget = fromLink ? resolve(dirname(from), readlinkSync(from)) : null;
  if (fromDir && !lexists(to)) return { state: "pending", root: from };
  if (fromDir) return { state: "conflict", root: from, why: `${to} 已经存在，不会覆盖` };
  if (toDir && !lexists(from)) return { state: "moved", root: to, link: "absent" };
  if (toDir && fromLink) {
    return linkTarget === to
      ? { state: "moved", root: to, link: "ours" }
      : { state: "conflict", root: to, why: `${from} 是指向 ${linkTarget} 的链接，不是指向 ${to}` };
  }
  return { state: "missing", root: null, why: `${from} 和 ${to} 都不是目录` };
}

function openReadOnly(file, errors) {
  try { return new DatabaseSync(file, { readOnly: true }); }
  catch (error) { errors.push(`打不开库 ${file}（${error.message}）`); return null; }
}

/** 库里每个文本列还有几处旧路径，以及旧根后面紧跟文字、分不清归属的有几处（不改，只报）。 */
export function scanDb(dbFile, rules, errors) {
  const out = { file: dbFile, refs: [], total: 0, ambiguous: 0, ambiguousSamples: [] };
  if (!lexists(dbFile)) return { ...out, missing: true };
  const db = openReadOnly(dbFile, errors);
  if (!db) return out;
  try {
    for (const { name: table } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      for (const { name: column } of db.prepare(`PRAGMA table_info("${table}")`).all()) {
        const probe = rules.map(() => `instr("${column}", ?) > 0`).join(" OR ");
        const rows = db.prepare(`SELECT "${column}" AS v FROM "${table}" WHERE typeof("${column}") = 'text' AND (${probe})`).all(...rules.map((r) => r.old));
        let count = 0;
        for (const { v } of rows) {
          count += countRefs(v, rules);
          const a = countAmbiguous(v, rules);
          out.ambiguous += a;
          if (a && out.ambiguousSamples.length < 5) out.ambiguousSamples.push(`${table}.${column}`);
        }
        if (count) out.refs.push({ table, column, rows: rows.length, count });
      }
    }
    out.total = out.refs.reduce((n, r) => n + r.count, 0);
  } catch (error) {
    errors.push(`读库 ${dbFile} 失败（${error.message}）`);
  } finally {
    db.close();
  }
  return out;
}

/**
 * 库里以旧写法开头、后面却不是 `/` 的整值路径（含 JSON 文本里的字符串值）：那是另一个目录（`<旧根> copy`），
 * 不管它此刻在不在磁盘上，正文里也不许把它当成这棵树换掉。返回它们的名字后缀。
 */
export function dbSiblingSuffixes(dbFile, rules, errors) {
  const out = new Set();
  if (!lexists(dbFile)) return out;
  const db = openReadOnly(dbFile, errors);
  if (!db) return out;
  const visit = (v) => {
    if (typeof v === "string") { for (const r of rules) { const x = otherDirSuffix(v, r.old); if (x !== null) out.add(x); } }
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { visit(k); visit(x); }
  };
  try {
    for (const { name: table } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      for (const { name: column } of db.prepare(`PRAGMA table_info("${table}")`).all()) {
        const probe = rules.map(() => `instr("${column}", ?) > 0`).join(" OR ");
        for (const { v } of db.prepare(`SELECT "${column}" AS v FROM "${table}" WHERE typeof("${column}") = 'text' AND (${probe})`).all(...rules.map((r) => r.old))) {
          visit(v);
          if (/^\s*[[{]/.test(v)) { try { visit(JSON.parse(v)); } catch { /* 不是 JSON */ } }
        }
      }
    }
  } catch (error) {
    errors.push(`读库 ${dbFile} 失败（${error.message}）`);
  } finally {
    db.close();
  }
  return out;
}

/** 配置文件里的字面量同理（JSON 的键和值、TOML 的字符串）。 */
function configSiblingSuffixes(files, rules, errors) {
  const out = new Set();
  for (const { file, kind } of files) {
    const text = readTextOr(file, errors);
    if (text === null) continue;
    for (const v of configStrings(text, kind)) {
      for (const r of rules) { const x = otherDirSuffix(v, r.old); if (x !== null) out.add(x); }
    }
  }
  return out;
}

/** 库里登记的、跟这棵树有关的东西：在跑的任务、在盯的哨兵、执行器的配置目录。 */
export function scanDbState(dbFile, errors) {
  const out = { running: [], monitors: [], configDirs: { claude: [], codex: [] } };
  if (!lexists(dbFile)) return out;
  const db = openReadOnly(dbFile, errors);
  if (!db) return out;
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  try {
    if (has("tasks")) out.running = db.prepare("SELECT id, title, status FROM tasks WHERE status IN ('running','queued')").all();
    if (has("monitors")) out.monitors = db.prepare("SELECT id, task_id AS taskId FROM monitors WHERE status = 'running'").all();
    if (has("sessions") && db.prepare("PRAGMA table_info(sessions)").all().some((c) => c.name === "cli_config_dir")) {
      for (const agent of ["claude", "codex"]) {
        out.configDirs[agent] = db.prepare("SELECT DISTINCT cli_config_dir AS d FROM sessions WHERE agent_type = ? AND cli_config_dir IS NOT NULL AND cli_config_dir <> ''").all(agent).map((r) => r.d);
      }
    }
  } catch (error) {
    errors.push(`读库 ${dbFile} 失败（${error.message}）`);
  } finally {
    db.close();
  }
  return out;
}

/** 服务还开着这份库吗：单例锁、在线登记、维护锁（见 relocate-checkout-lock.mjs），以及开着库文件的进程。 */
export function scanService(dbFile, runsDirs, errors) {
  const { reasons, errors: unknown } = liveHolders(dbFile, runsDirs);
  errors.push(...unknown);
  if (lexists(dbFile)) {
    // lsof 没找到任何进程时退出码也是 1（且不出声）；出声的 1 才是没查成。
    const r = sh("lsof", ["-Fp", "--", dbFile], errors, { what: "查谁开着库文件", okCodes: [0, 1] });
    if (r?.status === 1 && r.stderr.trim()) errors.push(`查谁开着库文件失败：${r.stderr.trim().split("\n")[0]}`);
    for (const pid of (r?.stdout ?? "").split("\n").filter((l) => l.startsWith("p")).map((l) => Number(l.slice(1)))) {
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
    const next = Number((sh("ps", ["-o", "ppid=", "-p", String(pid)], []) ?? { stdout: "" }).stdout.trim());
    if (!Number.isInteger(next) || next <= 0) break;
    pid = next;
  }
  return out;
}

const SHELLS = new Set(["zsh", "-zsh", "bash", "-bash", "sh", "fish", "-fish", "login"]);

/**
 * 工作目录在树里的进程会拦下真做：agent、哨兵、预览、构建……搬目录时它们手里的路径全会失效。
 * 例外是本脚本和它的祖先，以及纯交互 shell（搬完它们的 `$PWD` 只是显示旧路径，留着链接时照样能用）。
 * 命令行里带旧路径、但工作目录不在树里的（别的会话拉起的 navi MCP）只提示：它们已经把文件读进内存，
 * 留着链接时新起的也找得到。lsof / ps 没跑成就记错误 —— 不知道谁在树里，不等于没人在树里。
 */
export function scanProcesses(roots, errors) {
  const self = ancestors();
  const blocking = [];
  const shells = [];
  const argvRefs = [];
  const lsof = sh("lsof", ["-a", "-d", "cwd", "-FpRcn"], errors, { what: "列进程的工作目录" });
  let cur = null;
  for (const line of (lsof?.stdout ?? "").split("\n")) {
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
  const ps = sh("ps", ["-axww", "-o", "pid=,command="], errors, { what: "列进程的命令行" });
  for (const line of (ps?.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || self.has(Number(m[1]))) continue;
    if (roots.some((r) => m[2].includes(r + sep) || m[2].endsWith(r)) && !blocking.some((p) => p.pid === Number(m[1]))) {
      argvRefs.push({ pid: Number(m[1]), command: m[2].slice(0, 160) });
    }
  }
  return { blocking, shells, argvRefs };
}

const findIn = (root, args, errors, what) => {
  const r = sh("find", [root, "-name", "node_modules", "-prune", "-o", ...args, "-print0"], errors, { what });
  return r ? r.stdout.split("\0").filter(Boolean) : [];
};

/**
 * git 工作区的两头：仓库里 `.git/worktrees/<名>/gitdir` 记着工作区的 `.git` 在哪，工作区里的 `.git`
 * 文件记着 `gitdir: <仓库>/.git/worktrees/<名>`。两头可以是绝对路径，也可以是相对路径（`git worktree add
 * --relative-paths`，各自相对**文件所在目录**）。搬完都要指对：绝对的换前缀；相对的按新位置重算相对路径
 * （等价于 `git worktree repair`，只是直接改这两份文件，好记账、好退回）。树里的嵌套仓库、登记在树外的
 * 工作区、树里那些属于树外仓库的工作区都算。
 */
export function scanWorktrees(root, { from, to, errors }) {
  const moved = root === to;
  const after = (p) => mapPath(p, from, to) ?? p; // 搬完之后在哪
  const now = (p) => (moved ? after(p) : mapPath(p, to, from) ?? p); // 此刻在哪（p 是任一侧的写法）
  const before = (p) => mapPath(p, to, from) ?? p; // 搬之前在哪
  const recorded = (file, dotGit) => {
    const text = readTextOr(file, errors);
    if (text === null) return null;
    const m = dotGit ? /^gitdir:\s*(.+?)\s*$/m.exec(text) : /^(.+?)\s*$/m.exec(text);
    return m ? { text, value: m[1] } : null;
  };
  /** 记录下来的路径**搬完之后**该指向哪；指的东西此刻不在了返回 null。相对路径先按文件此刻所在目录解析，
   *  解析不到再按它搬之前所在的目录解析（上级目录变了的那种）。 */
  const target = (file, value) => {
    if (isAbsolute(value)) return lexists(now(value)) ? after(value) : null;
    const here = resolve(dirname(file), value);
    if (lexists(here)) return after(here);
    const then = resolve(before(dirname(file)), value);
    return lexists(now(then)) ? after(then) : null;
  };
  const adminFiles = new Set();
  const dotGitFiles = new Set(findIn(root, ["-type", "f", "-name", ".git"], errors, "在树里找工作区的 .git"));
  for (const admin of findIn(root, ["-type", "d", "-path", "*/.git/worktrees"], errors, "在树里找工作区登记")) {
    for (const name of listDir(admin, errors)) adminFiles.add(join(admin, name, "gitdir"));
  }
  for (const file of [...dotGitFiles]) {
    const r = recorded(file, true);
    const t = r && target(file, r.value);
    if (t) adminFiles.add(join(now(t), "gitdir"));
  }
  const items = [];
  const edits = [];
  const edit = (file, r, t) => {
    if (!t) return;
    const next = isAbsolute(r.value) ? t : relative(dirname(after(file)), t);
    if (next !== r.value) edits.push({ file, text: r.text, next: r.text.replace(r.value, next) });
  };
  for (const file of adminFiles) {
    const r = recorded(file, false);
    if (!r) continue;
    const t = target(file, r.value);
    if (t) dotGitFiles.add(now(t));
    const guess = isAbsolute(r.value) ? after(r.value) : after(resolve(dirname(file), r.value));
    items.push({ admin: after(dirname(file)), repoGitDir: after(dirname(dirname(dirname(file)))), worktree: dirname(t ?? guess), missing: !t });
    // 已经不在了的工作区（git 当可清理的那种）：绝对路径照样换前缀，相对的原样留着。
    edit(file, r, t ?? (isAbsolute(r.value) ? after(r.value) : null));
  }
  for (const file of dotGitFiles) {
    if (adminFiles.has(file)) continue;
    const r = recorded(file, true);
    if (r) edit(file, r, target(file, r.value));
  }
  return { items, edits };
}

/** 搬完之后的硬核对：每个工作区 git 都认得，而且认回的是它登记所在的那个仓库。 */
export function checkWorktrees(items) {
  const problems = [];
  const git = (cwd, args) => sh("git", ["-C", cwd, ...args], problems, { what: `${cwd}：git ${args.join(" ")} ` })?.stdout.trim();
  for (const w of items) {
    if (w.missing) {
      if (isDirNoFollow(w.worktree)) problems.push(`${w.worktree}：目录在，但 git 两头的登记对不上`);
      continue;
    }
    const top = git(w.worktree, ["rev-parse", "--show-toplevel"]);
    const common = git(w.worktree, ["rev-parse", "--git-common-dir"]);
    if (top !== undefined && top !== w.worktree) problems.push(`${w.worktree}：git 认成了 ${top}`);
    if (common !== undefined && resolve(w.worktree, common) !== w.repoGitDir) problems.push(`${w.worktree}：仓库指向 ${resolve(w.worktree, common)}`);
  }
  return problems;
}

/** 树里指向旧根的绝对链接（工作区借主仓 node_modules 的那批都是）；以及跨出树、换了上级目录会断的相对链接。 */
export function scanSymlinks(root, { from, to, errors }) {
  const retarget = [];
  const escaping = [];
  for (const path of (sh("find", [root, "-type", "l", "-print0"], errors, { what: "在树里找链接" })?.stdout ?? "").split("\0").filter(Boolean)) {
    let target;
    try { target = readlinkSync(path); } catch (error) { errors.push(`读不了链接 ${path}（${error.code}）`); continue; }
    if (isAbsolute(target)) {
      const next = mapPath(target, from, to);
      if (next) retarget.push({ path, target, next });
    } else if (dirname(from) !== dirname(to) && !isUnder(resolve(dirname(path), target), root)) {
      escaping.push({ path, target });
    }
  }
  return { retarget, escaping };
}

/** 数据目录里按路径做键的小文件（技能校准按「执行器 + 工作目录」记）。 */
export function scanDataFiles(dataRoot, rules, errors) {
  const out = [];
  for (const name of ["skill-calibrations.json"]) {
    const file = join(dataRoot, name);
    const text = readTextOr(file, errors);
    if (text === null) continue;
    const { count, problems } = analyzeConfig(text, "json", rules);
    if (count) out.push({ file, count, problems });
  }
  return out;
}

/** 远端：仓库在 GitHub 上改名之后要换的地址。 */
export function scanRemote(root) {
  const url = (sh("git", ["-C", root, "remote", "get-url", "origin"], []) ?? { stdout: "" }).stdout.trim() || null;
  const m = url && new RegExp(`^(.*github\\.com[:/][^/]+\\/)(?:${LEGACY_REPO_DIR_NAMES.join("|")})(\\.git)?$`).exec(url);
  return { url, suggested: m ? `${m[1]}navi${m[2] ?? ""}` : null };
}

/** 旧根的上级目录里，名字是「旧根名 + 后缀」的兄弟目录的后缀（`" copy"`、`"-old"`）。 */
function diskSiblingSuffixes({ from, to }, errors) {
  const name = basename(from);
  return listDir(dirname(from), errors).filter((n) => n !== name && n !== basename(to) && n.startsWith(name)).map((n) => n.slice(name.length));
}

/**
 * 整份清点。claims 是 --claude-claim / --claude-skip 点名的 claude 目录。资源位置全部来自 resolveRoots
 * （此刻的位置），搬前搬后、重跑、加锁、核对看的是同一份。
 */
export function scan({ from, to, home, db: dbExplicit, env = process.env, claims }) {
  const errors = [];
  const where = locateTree({ from, to });
  const plan = { from, to, home, where, errors, rules: rewriteRules({ from, to, home }) };
  if (!where.root) return plan;
  const root = where.root;
  const pair = { from, to };
  try { plan.sameDevice = statSync(root).dev === statSync(dirname(to)).dev; } catch { plan.sameDevice = false; }
  const rootsArgs = { home, env, from, to, root, dbExplicit, errors };
  // 库里登记的配置目录也是资源根，先用不带它的那份找到库，再带上它整份解析。
  plan.dbState = scanDbState(resolveRoots({ ...rootsArgs, errors: [] }).dbFile, errors);
  const roots = resolveRoots({ ...rootsArgs, dbDirs: plan.dbState.configDirs });
  plan.roots = roots;
  plan.env = staleEnv(env, pair);
  plan.dbFile = roots.dbFile;
  plan.worktrees = scanWorktrees(root, { from, to, errors });
  plan.claude = scanClaude(roots.claude, { from, to, claims, errors });

  // claude 会话目录改名的映射：本次认领的，加上账本里记过的（改过名的目录磁盘上已经证明不了归属）。
  let history = new Map();
  try { history = Journal.claudeHistory(home, pair); } catch (error) { errors.push(error.message); }
  const moves = new Map(history);
  for (const m of plan.claude.moves) moves.set(`${afterPath(m.configDir, pair)}/projects/${basename(m.from)}`, basename(m.to));
  plan.claudeMap = moves;

  const base = rewriteRules({ from, to, home });
  const siblings = new Set([...diskSiblingSuffixes(pair, errors), ...dbSiblingSuffixes(plan.dbFile, base, errors), ...configSiblingSuffixes(roots.configFiles, base, errors)]);
  const rules = rewriteRules({ from, to, home, siblings: [...siblings], claude: { prefixes: claudePrefixes(roots.claude, { from, to, home }), moves } });
  plan.rules = rules;
  plan.db = scanDb(plan.dbFile, rules, errors);
  plan.service = scanService(plan.dbFile, roots.runsDirs, errors);
  plan.processes = scanProcesses([from, to], errors);
  plan.symlinks = scanSymlinks(root, { from, to, errors });
  // 长期记忆：本次要搬的目录（此刻还在旧名下）和账本里搬过的目录（此刻在新名下）。
  const memoryDirs = [
    ...plan.claude.moves.map((m) => m.from),
    ...[...history].map(([key, next]) => join(currentPath(dirname(key), { ...pair, moved: roots.moved }), next)),
  ];
  plan.memoryDirs = memoryDirs;
  plan.memory = memoryFiles(memoryDirs, errors).map((file) => ({ file, count: countRefs(readTextOr(file, errors) ?? "", rules) })).filter((m) => m.count);
  plan.grok = scanGrok(roots.grokSessions, { from, to, errors });
  plan.opencode = scanOpencode(roots.opencodeDb, { from, to, errors });
  plan.configs = scanConfigs(home, rules, { files: roots.configFiles, from, to, errors });
  plan.dataFiles = scanDataFiles(roots.dataRoot, rules, errors);
  plan.remote = scanRemote(root);
  return plan;
}
