// 放回原样的那一段，在一个单独的 node 子进程里跑（git-accept-rollback.ts 的 restoreOwned 拉起它，
// 跑的是 ash 自己这段代码，不碰项目里的任何程序）。为什么非得是子进程，见 git-accept-rollback.ts 顶部：
// 要的是「目录对象锚定」——逐级 chdir 进去、每一级核对身份，之后只按相对名字动当前目录里的条目；
// chdir 是整个进程共享的，ash 主进程里不能这么做。
//
// 输入（stdin，JSON）：Backup（root / rootId / saved / dirs）加 `landed`（路径 → 这次写下的那个条目的身份）。
// 输出（stdout 最后一行，JSON）：没能回到原样的路径，目录带结尾的 `/`。
//
// 每一种改动都只落在锚定的当前目录里、只碰核过身份的条目：
//  · 清掉这次写下的：先原子改名成私有名字，再核身份；对得上才删，对不上原样挪回（什么都不毁）；
//  · 放回文件：硬链接回原来那个 inode（link 不覆盖已有条目），落下后再核 inode；链接用 symlink（同样不覆盖）；
//  · 删目录只用 rmdir（只删空的）；补权限先 chdir 进那个目录、核过身份，再对 `.` 改；
//  · 父目录缺了就在锚定的上一级里建，建出来的记下身份，之后只认它。
// 全部动完从根重新逐级核一遍，链路已经不在检出里的一律记成没回到原样 —— 不按变化后的路径补救。
export const RESTORE_CHILD = String.raw`"use strict";
const fs = require("fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const idOf = s => s.dev + ":" + s.ino;
const look = name => { try { return fs.lstatSync(name, { bigint: true }); } catch { return null; } };
const here = () => { try { return idOf(fs.statSync(".", { bigint: true })); } catch { return null; } };
const base = p => p.slice(p.lastIndexOf("/") + 1);
const parentOf = p => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".";
const depth = p => p.split("/").length;
const recorded = new Map(input.dirs.filter(d => d.existed).map(d => [d.path, d.id]));
const made = new Map();
let asides = 0;

// 锚定到检出里的目录 rel：true = 当前目录就是它；"absent" = 链路上某一级不存在（没让建）；false = 链路
// 不在这个检出里了（是链、不是目录、身份不对）。
function enter(rel, create) {
  try { process.chdir(input.root); } catch { return false; }
  if (here() !== input.rootId) return false;
  if (rel === ".") return true;
  let at = "";
  for (const name of rel.split("/")) {
    at = at ? at + "/" + name : name;
    let s = look(name);
    if (!s) {
      if (!create) return "absent";
      let mine = false;
      try { fs.mkdirSync(name); mine = true; } catch {}
      s = look(name);
      if (mine && s && s.isDirectory()) made.set(at, idOf(s));
    }
    if (!s || !s.isDirectory()) return false;
    const want = made.has(at) ? made.get(at) : recorded.get(at);
    if (want !== undefined && want !== idOf(s)) return false;
    try { process.chdir(name); } catch { return false; }
    if (here() !== idOf(s)) return false;
  }
  return true;
}

function isBack(s, name) {
  const now = look(name);
  if (s.kind === "missing") return !now;
  if (s.kind === "link") { try { return !!now && now.isSymbolicLink() && fs.readlinkSync(name) === s.target; } catch { return false; } }
  return !!now && idOf(now) === s.id;
}

// 只拿走正是 id 的那个条目：改名到私有名字（原子），核过身份才删；不是就挪回原位（原位已被占就留在私有名字下）。
function takeAway(name, id) {
  const aside = ".ash-restore-" + process.pid + "-" + asides++;
  try { fs.renameSync(name, aside); } catch { return false; }
  const s = look(aside);
  if (s && idOf(s) === id) { try { fs.unlinkSync(aside); return true; } catch { return false; } }
  if (!look(name)) { try { fs.renameSync(aside, name); } catch {} }
  return false;
}

function settle(s) {
  const name = base(s.path);
  if (isBack(s, name)) return true;
  if (s.kind === "other") return false;
  const now = look(name);
  if (now) {
    if (now.isDirectory()) { try { fs.rmdirSync(name); } catch { return false; } }
    else if (input.landed[s.path] !== idOf(now) || !takeAway(name, idOf(now))) return false;
  }
  if (s.kind === "link") { try { fs.symlinkSync(s.target, name); } catch { return false; } }
  if (s.kind === "file") {
    try { fs.linkSync(s.keep, name); } catch { return false; }
    const got = look(name);
    if (!got || idOf(got) !== s.id) { if (got) takeAway(name, idOf(got)); return false; }
  }
  return isBack(s, name);
}

const leaves = new Set();
const dirsLeft = new Set();
try {
  for (const s of [...input.saved].sort((a, b) => depth(b.path) - depth(a.path))) {
    const where = enter(parentOf(s.path), s.kind === "file" || s.kind === "link");
    if (where === "absent" && s.kind === "missing") continue;
    if (where !== true) { leaves.add(s.path); continue; }
    try { if (!settle(s)) leaves.add(s.path); } catch { leaves.add(s.path); }
  }
  for (const d of [...input.dirs].sort((a, b) => depth(b.path) - depth(a.path))) {
    const where = enter(parentOf(d.path), false);
    if (where === "absent" && !d.existed) continue;
    if (where !== true) { dirsLeft.add(d.path + "/"); continue; }
    const name = base(d.path);
    const s = look(name);
    if (!d.existed) {
      if (s && s.isDirectory()) { try { fs.rmdirSync(name); } catch { dirsLeft.add(d.path + "/"); } }
      continue;
    }
    if (s && idOf(s) === d.id) continue;
    if (s && s.isDirectory() && made.get(d.path) === idOf(s)) {
      try { process.chdir(name); if (here() === idOf(s)) fs.chmodSync(".", d.mode); } catch {}
    }
    dirsLeft.add(d.path + "/");
  }
  // 从根重新逐级核：动的过程中链路被换走的，放下去的东西已不在检出里这个路径上。
  for (const s of input.saved) {
    if (leaves.has(s.path)) continue;
    const where = enter(parentOf(s.path), false);
    if (where === "absent" && s.kind === "missing") continue;
    if (where !== true || !isBack(s, base(s.path))) leaves.add(s.path);
  }
} catch {
  for (const s of input.saved) leaves.add(s.path);
  for (const d of input.dirs) dirsLeft.add(d.path + "/");
}
const order = input.saved.map(s => s.path).filter(p => leaves.has(p));
process.stdout.write(JSON.stringify([...order, ...input.dirs.map(d => d.path + "/").filter(p => dirsLeft.has(p))]) + "\n");
`;
