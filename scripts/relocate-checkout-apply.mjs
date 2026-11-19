// 本地目录迁移的执行。每个会改盘的动作都经 journal.step：先把「怎么退回它」落盘，再动手（协议与退回
// 见 relocate-checkout-journal.mjs）。中途出错时账本里就是做到哪儿了：--rollback 照账本倒着退，或者修好
// 原因再跑一遍 —— 搬完目录之后整份重新清点一次再往下做，做过的不会再做。
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { memoryFiles, scanConfigs } from "./relocate-checkout-agents.mjs";
import { lexists } from "./relocate-checkout-fs.mjs";
import { relinkAtomic, writeAtomic } from "./relocate-checkout-journal.mjs";
import { mapPath, rewriteJson, rewriteText } from "./relocate-checkout-paths.mjs";
import { scan } from "./relocate-checkout-scan.mjs";

/** 把 src 整个挪到 dst；dst 已经有了就逐项并进去（同名目录往下并，内容相同的文件丢掉 src 那份）。 */
function moveTree(src, dst, journal, kind) {
  if (!lexists(dst)) {
    mkdirSync(dirname(dst), { recursive: true });
    journal.step({ kind, op: "rename", from: src, to: dst }, () => renameSync(src, dst));
    return;
  }
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dst, name);
    if (!lexists(d)) {
      journal.step({ kind, op: "rename", from: s, to: d }, () => renameSync(s, d));
    } else if (lstatSync(s).isDirectory() && lstatSync(d).isDirectory()) {
      moveTree(s, d, journal, kind);
    } else if (lstatSync(s).isFile() && readFileSync(s).equals(readFileSync(d))) {
      const { backup } = journal.backup(s);
      journal.step({ kind, op: "drop-identical", file: s, backup }, () => unlinkSync(s));
    } else {
      throw new Error(`合并 ${src} → ${dst} 时撞上不同内容的 ${name}（演练时没有这个冲突，期间被改过）`);
    }
  }
  journal.step({ kind, op: "rmdir", dir: src }, () => rmdirSync(src));
}

/**
 * 库里每个文本列里的旧路径换掉，一个事务。动手之前先 checkpoint：WAL 模式的库把日志并回主文件、截成
 * 空，主文件才是完整的一份，备份它才算数（没 checkpoint 就复制主文件会丢掉还在 -wal 里的那部分）。
 * checkpoint 被别的连接挡住（busy）说明还有人开着库，不动。
 */
function rewriteDb(file, rules, journal, log) {
  if (!existsSync(file)) return;
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const ckpt = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (ckpt?.busy) throw new Error(`${file} 还有别的连接开着（checkpoint 被挡住），服务真的停了吗？`);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
    const work = [];
    for (const table of tables) {
      const info = db.prepare(`PRAGMA table_info("${table}")`).all();
      let key = ["rowid"];
      try { db.prepare(`SELECT rowid FROM "${table}" LIMIT 1`).all(); } catch { key = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name); }
      for (const { name: column } of info) {
        const probe = rules.map(() => `instr("${column}", ?) > 0`).join(" OR ");
        const keys = key.map((k, i) => `"${k}" AS k${i}`).join(", ");
        for (const row of db.prepare(`SELECT ${keys}, "${column}" AS v FROM "${table}" WHERE typeof("${column}") = 'text' AND (${probe})`).all(...rules.map((r) => r.old))) {
          const { text, count } = rewriteText(row.v, rules);
          if (count) work.push({ table, column, key, ids: key.map((_, i) => row[`k${i}`]), text });
        }
      }
    }
    if (!work.length) return;
    const { backup } = journal.backup(file);
    let changed = 0;
    journal.step({ kind: "db", op: "restore", file, backup }, () => {
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
      db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    });
    log(`  库：改了 ${changed} 个值（${file}）`);
  } finally {
    db.close();
  }
}

/** JSON 文件逐层改写（键也换），文本文件按行内前缀换。JSON 键改完撞名就停下：哪份该留只有人知道。 */
function rewriteFile(file, kind, rules, journal, log, label) {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  let next;
  if (kind === "json") {
    const value = JSON.parse(text);
    const collisions = [];
    const rewritten = rewriteJson(value, rules, collisions);
    if (collisions.length) throw new Error(`${file}：键改完会和已有的重名（${collisions.map((c) => c.existing).join("、")}），演练时没有，期间被改过`);
    if (JSON.stringify(rewritten) === JSON.stringify(value)) return false;
    next = JSON.stringify(rewritten, null, /^\{\n(\s+)/.exec(text)?.[1] ?? 2) + (text.endsWith("\n") ? "\n" : "");
  } else {
    const r = rewriteText(text, rules);
    if (!r.count) return false;
    next = r.text;
  }
  const { backup, mode } = journal.backup(file);
  journal.step({ kind: label, op: "restore", file, backup, mode }, () => writeAtomic(file, next, mode));
  if (log) log(`  ${label}：${file}`);
  return true;
}

function relink(items, journal, kind) {
  for (const { path, target, next } of items) journal.step({ kind, op: "relink", path, target, next }, () => relinkAtomic(path, next));
}

/**
 * 真做。plan 是事前那份清点（已经过了预检、在维护锁里复查过）。目录一搬完就整份重新清点，后面每一步
 * 都照新的清点做：中断后重跑只做剩下的，树里的东西（个人档的配置目录、数据文件）也按新位置找。
 */
export function apply(plan, { journal, link, log, home, env, claims, db: dbExplicit }) {
  const { from, to } = plan;

  // 1. 搬目录。同一个文件系统里 rename(2) 一步完成，不复制。
  if (plan.where.state === "pending") {
    journal.step({ kind: "tree", op: "rename", from, to }, () => renameSync(from, to));
    log(`  目录：${from} → ${to}`);
  }

  // 2. 过渡链接：旧路径继续能用（取舍见 docs/relocate-checkout.md）。
  if (link && !lexists(from)) {
    const target = dirname(from) === dirname(to) ? basename(to) : to;
    journal.step({ kind: "link", op: "unlink", path: from, target }, () => symlinkSync(target, from));
    log(`  链接：${from} → ${target}`);
  }

  const now = scan({ from, to, home, env, claims, db: dbExplicit && (mapPath(dbExplicit, from, to) ?? dbExplicit) });
  if (now.errors.length) throw new Error(`搬完目录后重新清点时有读不到的东西：${now.errors.slice(0, 3).join("；")}`);
  const { rules } = now;

  // 3. git 工作区两头的路径。
  for (const edit of now.worktrees.edits) {
    const { backup, mode } = journal.backup(edit.file);
    journal.step({ kind: "worktree", op: "restore", file: edit.file, backup, mode }, () => writeAtomic(edit.file, edit.next, mode));
  }
  if (now.worktrees.edits.length) log(`  git 工作区：改了 ${now.worktrees.edits.length} 份路径文件`);

  // 4. 树里指向旧根的绝对链接改指新根（先建临时链接再改名盖上，任何时刻链接都在）；树外指进树里的配置链接也改指。
  relink(now.symlinks.retarget, journal, "symlink");
  if (now.symlinks.retarget.length) log(`  链接改指新位置：${now.symlinks.retarget.length} 个`);
  relink(now.configs.relink, journal, "config-link");
  for (const r of now.configs.relink) log(`  配置链接：${r.path} → ${r.next}`);

  // 5. navi 的库。
  rewriteDb(now.dbFile, rules, journal, log);

  // 6. 数据目录里按路径做键的文件。
  for (const f of now.dataFiles) rewriteFile(f.file, "json", rules, journal, log, "数据文件");

  // 7. claude 的会话目录，然后是所有已认领目录里的长期记忆（含工作区自己的、子目录里的）。
  for (const m of now.claude.moves) moveTree(m.from, m.to, journal, "claude");
  if (now.claude.moves.length) log(`  claude 会话目录：${now.claude.moves.length} 个`);
  let memory = 0;
  for (const file of memoryFiles(now.dirs.claude, { to, errors: [] })) if (rewriteFile(file, "text", rules, journal, null, "记忆")) memory += 1;
  if (memory) log(`  claude 长期记忆：改了 ${memory} 份`);

  // 8. grok 的会话目录。
  for (const m of now.grok.moves) moveTree(m.from, m.to, journal, "grok");
  if (now.grok.moves.length) log(`  grok 会话目录：${now.grok.moves.length} 个`);

  // 9. opencode 的会话工作目录。
  const oc = now.opencode;
  if (oc.rows.length) {
    const db = new DatabaseSync(oc.file);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      journal.step({ kind: "opencode", op: "rows", file: oc.file, rows: oc.rows }, () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const r of oc.rows) db.prepare(`UPDATE "${r.table}" SET directory = ? WHERE id = ? AND directory = ?`).run(r.next, r.id, r.directory);
          db.exec("COMMIT");
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch { /* 没开起来 */ }
          throw new Error(`改 opencode 的库失败，整份没动：${error.message}`);
        }
      });
    } finally {
      db.close();
    }
    log(`  opencode 会话：${oc.rows.length} 条`);
  }

  // 10. 各家 CLI 的配置（MCP 登记、项目信任表）。链接改指之后再清点一次，正文按链接此刻指着的那份改。
  const configs = scanConfigs(home, rules, { env, dirs: now.dirs, from, to, errors: [] });
  for (const c of configs.rewrite) {
    if (c.problems.length) throw new Error(`${c.file}：${c.problems.join("；")}（演练时没有，期间被改过）`);
    rewriteFile(c.file, c.kind, rules, journal, log, "配置");
  }
}
