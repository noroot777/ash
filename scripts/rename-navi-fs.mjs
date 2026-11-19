// 改名脚本（scripts/rename-navi.mjs）的仓库边界：哪些路径能读、能写、能挪、能建。
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const REPO_REAL = realpathSync(REPO);

// 仓库边界只认一条：脚本读、写、挪、建的每一条路径，从仓库根往下每一级都不许是符号链接 —— 链接本身
// （readFileSync / writeFileSync 会穿过它）和路径上的目录链接（再往下就到了链接指着的地方，可能在仓库外）都算。
// 规划时用 ancestorProblem + diskKind 认；动手时每一步再认一遍，源和落点都认：挪之前 assertSameSource（源的每一级、
// 源是不是规划时那一份），建目录 ensureDir，写正文 writeInRepo（换上之前的最后一刻再核目录、身份和原文）。
// 规划之后、动手之前工作区被别的进程换掉的，在这里停下，不拿规划时的结论去挪、去盖。
//
// 每一个按路径改动磁盘的系统调用都照同一个次序：慢的先做（读原文、写临时文件、建目录），最后只做便宜的
// 核对（逐级 lstat、按 lstat 比身份和戳），核完紧接着就是那一次系统调用 —— 中间不夹任何读盘、建目录、起进程。
// 旧句柄核过的 inode 不能代替对当前路径的核对：路径可以已经指向别的文件了。按路径动手的一共这几处，一处不漏：
//   建目录 mkdir（ensureDir，逐级 lstat 完紧接着建这一级）；建临时文件 open(O_CREAT)；换上正文 rename、新建 link；
//   挪名 rename（moveInRepo）；删临时文件 unlink。往临时文件里写、改权限、落盘走的是 open 拿到的句柄，写的是自己
//   刚建的那个 inode，不再按路径找。索引（.git/index）由 git 自己写，不是工作区路径。
// 不防的：最后那次核对和紧接着的那一次系统调用之间的瞬间（Node 没有 openat / renameat 那种「整条路径绑在一个
// 句柄上」的调用）。改名要在没有别人同时改工作区的检出上跑，这一档只是让它不会悄悄改错。

/** 路径上（不含最后一级）第一处走不通的：符号链接，或者是个文件。还不存在的那几级之后在仓库里新建，不算。 */
export function ancestorProblem(path) {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    let st;
    try {
      st = lstatSync(join(REPO, prefix));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (st.isSymbolicLink()) return `所在目录 ${prefix} 是符号链接`;
    if (!st.isDirectory()) return `路径上的 ${prefix} 不是目录`;
  }
  return null;
}

// 路径最后一级在磁盘上是什么。只有普通文件才读、才写正文；索引里有、工作区里删掉了（还没提交的删除）的没有东西可挪。
export function diskKind(path) {
  try {
    const st = lstatSync(join(REPO, path));
    return st.isSymbolicLink() ? "link" : st.isFile() ? "file" : "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

// 身份和戳都按 bigint 取：inode 号、纳秒时间戳放进 Number 会丢精度。
const lstatBig = (path) => lstatSync(join(REPO, path), { bigint: true });

/** 规划时这一份的身份：同一个设备上的同一个 inode（改名不换 inode）。 */
export function identity(path) {
  const st = lstatBig(path);
  return { dev: st.dev, ino: st.ino };
}

const sameFile = (st, id) => st.isFile() && !st.isSymbolicLink() && id && st.dev === id.dev && st.ino === id.ino;
// 戳：身份之外再加大小、内容改动时间、inode 改动时间（纳秒）。同一个 inode 上内容被改，mtime / ctime 跟着变。
const sameStamp = (st, stamp) => sameFile(st, stamp) && st.size === stamp.size && st.mtimeNs === stamp.mtimeNs && st.ctimeNs === stamp.ctimeNs;

/** 挪之前复核源：路径上每一级仍不是链接，它自己仍是规划时那一份普通文件。 */
export function assertSameSource(path, id) {
  const why = ancestorProblem(path);
  if (why) throw new Error(`${path}：规划之后${why}，停下`);
  let st;
  try {
    st = lstatBig(path);
  } catch (error) {
    throw new Error(`${path}：规划之后不见了（${error?.code ?? error}），停下`);
  }
  if (!sameFile(st, id)) throw new Error(`${path}：规划之后被换成了别的东西，停下`);
}

/**
 * 挪名。慢的先做：落点的上级逐级认、缺的建。然后只做便宜的核对 —— 源路径每一级仍不是链接、源仍是规划时那一份，
 * 落点上级每一级仍不是链接、真实位置仍在仓库里，落点仍空着 —— 紧接着 rename。挪完那一刻记进 done。
 * 已跟踪文件的索引由调用方随后更新（不用 git mv：它是另起一个进程挪的，核对贴不到它的那次 rename 前面）。
 */
export function moveInRepo(from, to, id, done, note = "") {
  ensureDir(dirname(to), done);
  assertSameSource(from, id);
  ensureDir(dirname(to), null);
  if (diskKind(to) !== "missing") throw new Error(`${to}：挪名的落点这时有了东西，不覆盖，停下`);
  renameSync(join(REPO, from), join(REPO, to));
  done.push(`挪了 ${from} → ${to}${note}`);
}

// 动手时的边界：目录逐级认、缺的才一级一级建，碰上链接或文件就在建任何东西之前停下（mkdir -p 会顺着目录链接
// 建到仓库外）；建了的目录记进 done，失败时一并列出来。最后再按真实路径核一遍还在仓库里。
// done 传 null 是只核不建：哪一级不在了也算变了。
export function ensureDir(dir, done) {
  const parts = dir === "." ? [] : dir.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    let st = null;
    try {
      st = lstatSync(join(REPO, prefix));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!st) {
      if (!done) throw new Error(`${prefix} 不见了，停下`);
      mkdirSync(join(REPO, prefix));
      done.push(`建了目录 ${prefix}`);
    } else if (st.isSymbolicLink()) throw new Error(`${prefix} 是符号链接，不透过它写`);
    else if (!st.isDirectory()) throw new Error(`${prefix} 不是目录`);
  }
  const real = realpathSync(join(REPO, dir));
  if (real !== REPO_REAL && !real.startsWith(REPO_REAL + sep)) throw new Error(`${dir} 的真实位置在仓库外（${real}），不写`);
}

// 写正文的最后一道，也是唯一一处写正文的地方。
//  · 新正文先完整写进同一目录下的临时文件（一直写到写满，短写接着写，没有进展就报错），fsync 落盘，
//    再一步换上：改已有的用 rename 原子替换（权限位照抄原文件），新建的用 link（落点这时有了任何东西都失败，
//    同 O_EXCL）。原地截断再写不行：截断之后写失败，原文就没了；--dirty 下那可能是没提交的内容，git 也找不回来。
//  · 换上之前的最后一刻再核一遍：所在目录每一级仍不是链接、真实位置仍在仓库里，临时文件仍是自己建的那个，
//    改已有的还要落点仍是规划时那一份（同一个 inode）、内容没被改过，新建的要落点仍空着。写临时文件、fsync
//    可能很慢，别的程序这期间保存了、原子保存换了 inode、把目录换成了链接，都在这里拦下：丢掉临时结果、停下。
//    动手之前也核一遍（不对就连临时文件都不写）；读完原文、建临时文件之前再按路径核一遍目录。
//  · 换上那一刻记进 done（之后清临时文件出错，这次改动也已经在清单里）；没换上就只删临时文件，原文件一个字节
//    都没动。临时文件没删掉也记进 done，说清在哪。
// 临时名固定短（不抄原文件名）：接近文件名长度上限的文件也放得下。expect = { original, id }。
export function writeInRepo(path, text, create, done, expect) {
  const abs = join(REPO, path);
  const dir = dirname(path);
  ensureDir(dir, done);
  // 慢的先做：对开着的原文件核身份、读原文，记下戳；最后一刻只按 lstat 比戳。
  const stamp = create ? null : checkTarget(path, expect);
  const mode = stamp ? Number(stamp.mode & 0o7777n) : null;
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW = 0 } = constants;
  const tempName = `.navi-rename-${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  const temp = join(dirname(abs), tempName);
  // 建临时文件也是按路径动手：读原文期间目录可能被换成了链接，核完紧接着建，不在仓库外建出东西来。
  ensureDir(dir, null);
  const fd = openSync(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW);
  let failure = null;
  let tempId = null;
  let tempLeft = true;
  try {
    try {
      const st = fstatSync(fd, { bigint: true });
      tempId = { dev: st.dev, ino: st.ino };
      if (mode !== null) fchmodSync(fd, mode);
      writeAll(fd, Buffer.from(text, "utf8"));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // 最后一刻：只有 lstat，核完紧接着 link / rename。
    ensureDir(dir, null);
    if (!sameFile(lstatSync(temp, { bigint: true }), tempId)) throw new Error(`${path}：临时文件 ${tempName} 被换掉了，停下`);
    if (create) {
      if (diskKind(path) !== "missing") throw new Error(`${path}：要新建的地方这时有了东西，不覆盖，停下`);
      linkSync(temp, abs);
    } else {
      let now = null;
      try {
        now = lstatBig(path);
      } catch {}
      if (!now || !sameStamp(now, stamp)) throw new Error(`${path}：规划之后被换成了别的文件或内容被改过，不拿规划时的结果盖它，停下`);
      renameSync(temp, abs);
      tempLeft = false;
    }
    done.push(`${create ? "建了" : "改了"} ${path}`);
  } catch (error) {
    failure = error;
  }
  // 删临时文件同样按路径：目录每一级仍不是链接、那个名字仍是自己建的那个文件，核完紧接着 unlink。
  // 认不准就不删（删的可能是链接那头别人的文件），记进 done 让人手工处理。
  if (tempLeft) {
    try {
      ensureDir(dir, null);
      let st = null;
      try {
        st = lstatSync(temp, { bigint: true });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (st && !sameFile(st, tempId)) throw new Error(`临时文件 ${tempName} 被换成了别的东西，不删`);
      if (st) unlinkSync(temp);
    } catch (error) {
      done.push(`留下了临时文件 ${dir === "." ? "" : `${dir}/`}${tempName}（${error?.code ?? error?.message ?? error}），手工删掉`);
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

/**
 * 落点仍是规划时那一份、内容没被改过：O_NOFOLLOW 打开（最后一级是链接就打不开），对开着的这个文件核身份、读原文。
 * 读之前、读之后各取一次戳，读的期间被改了也认得出。返回读完时的戳，最后一刻按它比。
 */
function checkTarget(path, expect) {
  const fd = openSync(join(REPO, path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!sameFile(before, expect.id)) throw new Error(`${path}：规划之后被换成了别的文件，不写，停下`);
    if (readFileSync(fd, "utf8") !== expect.original) throw new Error(`${path}：规划之后内容被改过，不拿规划时的结果盖它，停下`);
    const after = fstatSync(fd, { bigint: true });
    if (!sameStamp(after, before)) throw new Error(`${path}：读原文的时候内容被改了，停下`);
    return after;
  } finally {
    closeSync(fd);
  }
}

/** 一直写到写满：writeSync 返回的是实际写进去的字节数，短写不是写完了。 */
function writeAll(fd, buf) {
  for (let offset = 0; offset < buf.length; ) {
    const written = writeSync(fd, buf, offset, buf.length - offset, offset);
    if (!(written > 0)) throw new Error(`写入没有进展（停在第 ${offset} 字节）`);
    offset += written;
  }
}
