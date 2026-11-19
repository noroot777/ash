// 本地目录迁移的执行与退回。每做完一个原子动作就把「怎么退回它」记进账本（journal.json），
// 中途出错时账本里就是做到哪儿了：--rollback 照账本倒着退，或者修好原因再跑一遍（每一步都按
// 此刻磁盘上的样子现算，做过的不会再做）。
import { execFileSync } from "node:child_process";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync,
  rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { claudeSlug, mapPath, rewriteJson, rewriteText } from "./relocate-checkout-paths.mjs";
import { configFiles, opencodeDbFile, scanClaude, scanGrok, scanOpencode, scanSymlinks, scanWorktrees } from "./relocate-checkout-scan.mjs";

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const readText = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };

/** 同目录临时文件写满再改名换上：写到一半失败，原文件不动。 */
function writeAtomic(file, text) {
  const tmp = join(dirname(file), `.relocate-${process.pid}.tmp`);
  writeFileSync(tmp, text, { mode: lstatSync(file).mode & 0o7777 });
  renameSync(tmp, file);
}

export class Journal {
  constructor(dir, meta) {
    this.dir = dir;
    this.file = join(dir, "journal.json");
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { ...meta, startedAt: new Date().toISOString(), steps: [] };
  }
  static create(home, meta) {
    const dir = join(home, ".navi-relocate", stamp());
    mkdirSync(join(dir, "backup"), { recursive: true });
    const j = new Journal(dir, meta);
    j.save();
    return j;
  }
  /** 这对路径下所有还没退回过、真做过事的账本，新的在前（中途失败后重跑会留下不止一份）。 */
  static pending(home, { from, to }) {
    const base = join(home, ".navi-relocate");
    let runs = [];
    try { runs = readdirSync(base).filter((d) => existsSync(join(base, d, "journal.json"))).sort().reverse(); } catch { return []; }
    return runs.map((d) => new Journal(join(base, d)))
      .filter((j) => j.data.from === from && j.data.to === to && !j.data.rolledBackAt && j.data.steps.some((s) => !s.undone));
  }
  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
  add(step) {
    this.data.steps.push({ ...step, at: new Date().toISOString() });
    this.save();
  }
  /** 改文件之前留一份原样，返回备份的位置。 */
  backup(file) {
    const dst = join(this.dir, "backup", `${String(this.data.steps.length).padStart(5, "0")}-${basename(file)}`);
    copyFileSync(file, dst);
    return dst;
  }
}

/** 把 src 整个挪到 dst；dst 已经有了就逐项并进去（同名目录往下并，内容相同的文件丢掉 src 那份）。 */
function moveTree(src, dst, journal, kind) {
  if (!existsSync(dst)) {
    mkdirSync(dirname(dst), { recursive: true });
    renameSync(src, dst);
    journal.add({ kind, op: "rename", from: src, to: dst });
    return;
  }
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dst, name);
    if (!existsSync(d)) {
      renameSync(s, d);
      journal.add({ kind, op: "rename", from: s, to: d });
    } else if (lstatSync(s).isDirectory() && lstatSync(d).isDirectory()) {
      moveTree(s, d, journal, kind);
    } else if (lstatSync(s).isFile() && readFileSync(s).equals(readFileSync(d))) {
      const backup = journal.backup(s);
      unlinkSync(s);
      journal.add({ kind, op: "drop-identical", file: s, backup });
    } else {
      throw new Error(`合并 ${src} → ${dst} 时撞上不同内容的 ${name}（演练时没有这个冲突，期间被改过）`);
    }
  }
  rmdirSync(src);
  journal.add({ kind, op: "rmdir", dir: src });
}

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** 库里每个文本列里的旧路径换掉，一个事务；撞上唯一约束就整份不改。 */
function rewriteDb(file, rules, journal, log) {
  if (!existsSync(file)) return;
  const db = new DatabaseSync(file);
  let changed = 0;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
    const work = [];
    for (const table of tables) {
      const info = db.prepare(`PRAGMA table_info("${table}")`).all();
      let key = ["rowid"];
      try { db.prepare(`SELECT rowid FROM "${table}" LIMIT 1`).all(); } catch { key = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name); }
      for (const { name: column } of info) {
        const probe = rules.map(() => `instr("${column}", ?) > 0`).join(" OR ");
        const keys = key.map((k, i) => `"${k}" AS k${i}`).join(", ");
        const rows = db.prepare(`SELECT ${keys}, "${column}" AS v FROM "${table}" WHERE typeof("${column}") = 'text' AND (${probe})`).all(...rules.map((r) => r.old));
        for (const row of rows) {
          const { text, count } = rewriteText(row.v, rules);
          if (count) work.push({ table, column, key, ids: key.map((_, i) => row[`k${i}`]), text });
        }
      }
    }
    if (!work.length) return;
    const backup = journal.backup(file);
    for (const suffix of ["-wal", "-shm"]) if (existsSync(file + suffix)) throw new Error(`${file}${suffix} 还在：库没有正常关闭（服务真的停了吗？）`);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const w of work) {
        const where = w.key.map((k) => `"${k}" = ?`).join(" AND ");
        changed += Number(db.prepare(`UPDATE "${w.table}" SET "${w.column}" = ? WHERE ${where}`).run(w.text, ...w.ids).changes);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`改写库失败，整份没动：${error.message}`);
    }
    journal.add({ kind: "db", op: "restore", file, backup, values: changed });
    log(`  库：改了 ${changed} 个值（${file}）`);
  } finally {
    db.close();
  }
}

/** JSON 文件逐层改写（键也换），文本文件按行内前缀换。 */
function rewriteFile(file, kind, rules, journal, log, label) {
  const text = readText(file);
  if (text === null) return;
  let next;
  const collisions = [];
  if (kind === "json") {
    let value;
    try { value = JSON.parse(text); } catch { log(`  跳过 ${file}：不是合法 JSON`); return; }
    const rewritten = rewriteJson(value, rules, collisions);
    next = JSON.stringify(rewritten, null, /^\{\n(\s+)/.exec(text)?.[1] ?? 2) + (text.endsWith("\n") ? "\n" : "");
    if (JSON.stringify(rewritten) === JSON.stringify(value)) return;
  } else {
    const r = rewriteText(text, rules);
    if (!r.count) return;
    next = r.text;
  }
  const backup = journal.backup(file);
  writeAtomic(file, next);
  journal.add({ kind: label, op: "restore", file, backup });
  log(`  ${label}：${file}${collisions.length ? `（${collisions.length} 个键改完与已有的重名，保留了已有的：${collisions.map((c) => c.kept).join("、")}）` : ""}`);
}

/**
 * 真做。plan 是事前那份清点（已经过了预检）；每一步开始前按此刻的磁盘现算一遍，所以中断后重跑只做剩下的。
 */
export function apply(plan, { journal, link, log }) {
  const { from, to, home, rules } = plan;

  // 1. 搬目录。同一个文件系统里 rename(2) 一步完成，不复制。
  if (plan.where.state === "pending") {
    renameSync(from, to);
    journal.add({ kind: "tree", op: "rename", from, to });
    log(`  目录：${from} → ${to}`);
  }

  // 2. 过渡链接：旧路径继续能用（取舍见 docs/relocate-checkout.md）。
  if (link && !existsSync(from) && !(() => { try { return lstatSync(from).isSymbolicLink(); } catch { return false; } })()) {
    const target = dirname(from) === dirname(to) ? basename(to) : to;
    symlinkSync(target, from);
    journal.add({ kind: "link", op: "unlink", path: from, target });
    log(`  链接：${from} → ${target}`);
  }

  // 3. git 工作区两头的绝对路径。
  const { edits } = scanWorktrees(to, { from, to });
  for (const edit of edits) {
    const backup = journal.backup(edit.file);
    writeAtomic(edit.file, edit.next);
    journal.add({ kind: "worktree", op: "restore", file: edit.file, backup });
  }
  if (edits.length) log(`  git 工作区：改了 ${edits.length} 份路径文件`);

  // 4. 树里指向旧根的绝对链接改指新根（先建临时链接再改名盖上，任何时刻链接都在）。
  const { retarget } = scanSymlinks(to, { from, to });
  for (const { path, target, next } of retarget) {
    const tmp = join(dirname(path), `.relocate-${process.pid}.link`);
    symlinkSync(next, tmp);
    renameSync(tmp, path);
    journal.add({ kind: "symlink", op: "relink", path, target });
  }
  if (retarget.length) log(`  链接改指新位置：${retarget.length} 个`);

  // 5. navi 的库。
  rewriteDb(mapPath(plan.dbFile, from, to) ?? plan.dbFile, rules, journal, log);

  // 6. 数据目录里按路径做键的文件。
  for (const name of ["skill-calibrations.json"]) rewriteFile(join(to, "data", name), "json", rules, journal, log, "数据文件");

  // 7. claude 的会话目录与长期记忆。
  const claudeDirs = [...new Set([join(home, ".claude"), ...(plan.dbState?.claudeConfigDirs ?? []).map((d) => resolve(d))])];
  const known = new Set([from, ...plan.worktrees.items.map((w) => mapPath(w.worktree, to, from) ?? w.worktree)]);
  const claude = scanClaude(claudeDirs, { from, to, knownPaths: known });
  for (const m of claude.moves) moveTree(m.from, m.to, journal, "claude");
  if (claude.moves.length) log(`  claude 会话目录：${claude.moves.length} 个`);
  for (const configDir of claudeDirs) {
    const memory = join(configDir, "projects", claudeSlug(to), "memory");
    let files = [];
    try { files = readdirSync(memory).filter((f) => f.endsWith(".md")); } catch { continue; }
    for (const f of files) rewriteFile(join(memory, f), "text", rules, journal, () => {}, "记忆");
  }

  // 8. grok 的会话目录。
  const grok = scanGrok(home, { from, to });
  for (const m of grok.moves) moveTree(m.from, m.to, journal, "grok");
  if (grok.moves.length) log(`  grok 会话目录：${grok.moves.length} 个`);

  // 9. opencode 的会话工作目录。
  const oc = scanOpencode(opencodeDbFile(home), { from, to });
  if (oc.rows.length) {
    const db = new DatabaseSync(oc.file);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("BEGIN IMMEDIATE");
      for (const r of oc.rows) db.prepare(`UPDATE "${r.table}" SET directory = ? WHERE id = ? AND directory = ?`).run(r.next, r.id, r.directory);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* 没开起来 */ }
      throw new Error(`改 opencode 的库失败，整份没动：${error.message}`);
    } finally {
      db.close();
    }
    journal.add({ kind: "opencode", op: "rows", file: oc.file, rows: oc.rows });
    log(`  opencode 会话：${oc.rows.length} 条`);
  }

  // 10. 各家 CLI 的配置（MCP 登记、项目信任表）。
  for (const { file, kind } of configFiles(home)) {
    const problem = plan.configs?.rewrite.find((c) => c.file === file)?.problems.length;
    if (problem) { log(`  跳过 ${file}：${plan.configs.rewrite.find((c) => c.file === file).problems.join("；")}`); continue; }
    rewriteFile(file, kind, rules, journal, log, "配置");
  }
}

/** 按账本倒着退。只在迁移之后**还没启动服务**时用：库和配置是整份换回备份的。 */
export function rollback(journal, log) {
  const steps = journal.data.steps;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const s = steps[i];
    if (s.undone) continue;
    switch (s.op) {
      case "rename":
        mkdirSync(dirname(s.from), { recursive: true });
        renameSync(s.to, s.from);
        break;
      case "rmdir":
        mkdirSync(s.dir, { recursive: true });
        break;
      case "drop-identical":
        copyFileSync(s.backup, s.file);
        break;
      case "unlink":
        if (lstatSync(s.path).isSymbolicLink() && readlinkSync(s.path) === s.target) unlinkSync(s.path);
        break;
      case "restore":
        for (const suffix of ["-wal", "-shm"]) if (s.kind === "db" && existsSync(s.file + suffix)) rmSync(s.file + suffix);
        writeFileSync(s.file, readFileSync(s.backup));
        break;
      case "relink": {
        const tmp = join(dirname(s.path), `.relocate-${process.pid}.link`);
        symlinkSync(s.target, tmp);
        renameSync(tmp, s.path);
        break;
      }
      case "rows": {
        const db = new DatabaseSync(s.file);
        try {
          db.exec("BEGIN IMMEDIATE");
          for (const r of s.rows) db.prepare(`UPDATE "${r.table}" SET directory = ? WHERE id = ? AND directory = ?`).run(r.directory, r.id, r.next);
          db.exec("COMMIT");
        } finally {
          db.close();
        }
        break;
      }
      default:
        throw new Error(`账本里有认不得的一步：${JSON.stringify(s)}`);
    }
    s.undone = new Date().toISOString();
    journal.save();
    log(`  退回 ${s.kind}/${s.op}：${s.file ?? s.path ?? s.from ?? s.dir}`);
  }
  journal.data.rolledBackAt = new Date().toISOString();
  journal.save();
}

/** 搬完之后的硬核对：git 认得每个工作区、库和配置里没有旧路径、树里没有指向旧根的链接。 */
export function checkWorktrees(root) {
  const problems = [];
  let listing = "";
  try { listing = git(root, ["worktree", "list", "--porcelain"]); } catch (error) { return [`git worktree list 失败：${error.message}`]; }
  for (const line of listing.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const wt = line.slice("worktree ".length);
    if (wt === root || !existsSync(wt)) continue;
    try {
      const top = git(wt, ["rev-parse", "--show-toplevel"]).trim();
      const common = resolve(wt, git(wt, ["rev-parse", "--git-common-dir"]).trim());
      if (top !== wt) problems.push(`${wt}：git 认成了 ${top}`);
      if (common !== join(root, ".git")) problems.push(`${wt}：仓库指向 ${common}`);
    } catch (error) {
      problems.push(`${wt}：${String(error.stderr || error.message).trim().split("\n")[0]}`);
    }
  }
  return problems;
}
