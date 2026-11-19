// 本地目录迁移的账本（journal.json）与退回。
//
// 协议是**先记意图、再动手、再记完成**：每个会改盘的动作开始之前，把「怎么退回它」连同 state: intent
// 落盘（fsync 后改名换上）；落不下来就不动手。动手之后改成 done 再落一次。所以任何时刻中断（磁盘满、
// 被杀、断电），盘上的账本里都有这一步 —— 至多多出一步「记了意图、其实没做」的。
//
// 退回因此必须**按盘上此刻的样子判断要不要做**，而不是照账本盲做：每个退回动作先看两端（目录在哪一头、
// 链接现在指哪、行现在是什么值），已经是原样的就跳过。这样「只记了意图」的那一步退回时是空操作，
// 退回做到一半中断后重跑也不会因为源已经不在而卡住。
import {
  chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isLink, lexists } from "./relocate-checkout-fs.mjs";

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function writeDurable(file, data, mode) {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  const fd = openSync(tmp, "w", mode ?? 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (mode !== undefined) chmodSync(tmp, mode); // open 的 mode 受 umask 影响
  renameSync(tmp, file);
}

/**
 * 改一个文件：写同目录临时文件、改名换上，权限照原样。文件是符号链接（配置放在 dotfiles 里那种）时
 * 改它指着的那一份，链接本身原样留着 —— 直接盖掉会把链接换成普通文件、权限换成链接自己的 0777。
 */
export function writeAtomic(file, data, mode) {
  const real = existsSync(file) ? realpathSync(file) : file;
  writeDurable(real, data, mode ?? (existsSync(real) ? statSync(real).mode & 0o7777 : undefined));
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
  /** 这对路径下所有还没退回完、记过动作的账本，新的在前（中途失败后重跑会留下不止一份）。 */
  static pending(home, { from, to }) {
    const base = join(home, ".navi-relocate");
    let runs = [];
    try { runs = readdirSync(base).filter((d) => existsSync(join(base, d, "journal.json"))).sort().reverse(); } catch { return []; }
    return runs.map((d) => new Journal(join(base, d)))
      .filter((j) => j.data.from === from && j.data.to === to && j.data.steps.some((s) => !s.undone));
  }
  save() {
    writeDurable(this.file, JSON.stringify(this.data, null, 2));
  }
  /** 记下意图、动手、记下完成。意图落不了盘就抛错，act 不会被调用。 */
  step(entry, act) {
    const s = { ...entry, state: "intent", at: new Date().toISOString() };
    this.data.steps.push(s);
    try { this.save(); } catch (error) { this.data.steps.pop(); throw error; }
    const result = act?.();
    s.state = "done";
    this.save();
    return result;
  }
  /** 改文件之前留一份原样（文件是链接就留它指着的那份），返回 { backup, mode }。 */
  backup(file) {
    const real = realpathSync(file);
    const dst = join(this.dir, "backup", `${String(this.data.steps.length).padStart(5, "0")}-${basename(file)}`);
    copyFileSync(real, dst);
    return { backup: dst, mode: statSync(real).mode & 0o7777 };
  }
}

function relinkAtomic(path, target) {
  const tmp = join(dirname(path), `.relocate-${process.pid}.link`);
  try { unlinkSync(tmp); } catch { /* 没有残留 */ }
  symlinkSync(target, tmp);
  renameSync(tmp, path);
}

/** 退回一步。每种动作都先看盘上的样子：已经是原样就什么都不做。 */
function undo(s) {
  switch (s.op) {
    case "rename": {
      const atFrom = lexists(s.from);
      const atTo = lexists(s.to);
      if (atTo && !atFrom) { mkdirSync(dirname(s.from), { recursive: true }); renameSync(s.to, s.from); }
      else if (atFrom && atTo) throw new Error(`${s.from} 和 ${s.to} 都在，不知道该留哪个`);
      else if (!atFrom) throw new Error(`${s.from} 和 ${s.to} 都不在了`);
      return;
    }
    case "rmdir":
      mkdirSync(s.dir, { recursive: true });
      return;
    case "drop-identical":
      if (!lexists(s.file)) copyFileSync(s.backup, s.file);
      return;
    case "unlink":
      if (isLink(s.path) && readlinkSync(s.path) === s.target) unlinkSync(s.path);
      return;
    case "restore":
      if (s.kind === "db") {
        // 备份是 checkpoint 之后的整份主文件；留着的 -wal 会被 SQLite 叠在它上面重放，必须一起清掉。
        for (const suffix of ["-wal", "-shm"]) rmSync(s.file + suffix, { force: true });
        copyFileSync(s.backup, s.file);
      } else {
        writeAtomic(s.file, readFileSync(s.backup), s.mode);
      }
      return;
    case "relink":
      if (!isLink(s.path) || readlinkSync(s.path) !== s.target) relinkAtomic(s.path, s.target);
      return;
    case "rows": {
      const db = new DatabaseSync(s.file);
      try {
        db.exec("PRAGMA busy_timeout = 5000");
        db.exec("BEGIN IMMEDIATE");
        for (const r of s.rows) db.prepare(`UPDATE "${r.table}" SET directory = ? WHERE id = ? AND directory = ?`).run(r.directory, r.id, r.next);
        db.exec("COMMIT");
      } finally {
        db.close();
      }
      return;
    }
    default:
      throw new Error(`账本里有认不得的一步：${JSON.stringify(s)}`);
  }
}

export { relinkAtomic };

/** 按账本倒着退。只在迁移之后**还没启动服务**时用：库和配置是整份换回备份的。 */
export function rollback(journal, log) {
  const steps = journal.data.steps;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const s = steps[i];
    if (s.undone) continue;
    undo(s);
    s.undone = new Date().toISOString();
    journal.save();
    log(`  退回 ${s.kind}/${s.op}${s.state === "intent" ? "（只记了意图，按盘上的样子核过）" : ""}：${s.file ?? s.path ?? s.from ?? s.dir}`);
  }
  journal.data.rolledBackAt = new Date().toISOString();
  journal.save();
}
