// 「同一套资源的占有权」那把短命互斥锁。
//
// **为什么不能只各自检查对方的锁**：ash 启动和离线迁移各有一把长命锁（`.ash.lock` /
// `.maintenance.lock`），而两边原来都是「先查对方、再建自己」。这个合成动作不是原子的，
// 于是下面这串合法交错两边都能通过（第 1 轮审查 F2 用同步屏障实测复现）：
//
//   ① 迁移查服务：没有 → ② 服务查迁移：没有，建服务锁 → ③ 迁移建维护锁，开始写
//
// 两次检查各自都对，合起来不互斥。所以这里加一把**所有角色都必须先拿到**的占有锁：
// 「查对方 + 建自己」整段放在它里面，谁先拿到谁先把自己的长命锁落下来，另一边再进来时
// 就一定看得见。它只在那几毫秒里被持有，不是第三把所有权锁。
//
// 两条实现上的讲究：
// ① **建锁必须「带着内容原子出现」**（`link()` 而不是 `openSync("wx")` 再写）：先建空
//    文件再写内容的话，中间那一瞬别的进程读到一份读不懂的锁，会把活锁判成陈旧锁删掉，
//    而第一个进程手里的 fd 还在、照样返回成功（同一条审查意见的第二个面）。
// ② **按排好的顺序取多把**：一套资源包含库文件和 runs 目录两个键，所有角色都按字典序
//    取，顺序一致就不会互相等成死锁。
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, statSync,
  unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { isPidAlive } from "./platform.js";
import { inspectProcess } from "./proc.js";

const CLAIM_SUFFIX = ".ash-claim.lock";
/** 占有锁只在「查对方 + 建自己」那几毫秒里被持有，所以等 3 秒还拿不到就是真有人在抢。 */
const BUDGET_MS = 3_000;
const POLL_MS = 25;
/** 读不懂的残骸锁放这么久就清掉（活着的持有者**不**按时间判，见 `staleClaim`）。 */
const STALE_MS = 30_000;
/** 进程启动时刻的比较余量：ps 的精度到秒。 */
const START_TIME_TOLERANCE_MS = 10_000;

export class ResourceClaimError extends Error {
  constructor(public readonly claimFile: string, public readonly holder: string) {
    super(`这套资源正被另一个进程占着起手动作（${holder}）：${claimFile}\n`
      + "这把锁只该持有几毫秒；若它一直不放，确认那个进程已经不在之后删掉它。");
    this.name = "ResourceClaimError";
  }
}

export const claimFileFor = (key: string): string => `${key}${CLAIM_SUFFIX}`;

/**
 * 「这条路径的真实落点是什么」这一问**没答上来**。
 *
 * 和「这个位置还不存在」严格分开（第 3 轮复核 F1）：后者是规范化流程里的正常形态（库文件第一次
 * 创建、备份还没写），退一步解析父目录是对的；前者（权限、I/O、符号链接成环）退一步就等于拿一个
 * 没证明过的名字继续往下判归属 —— 而那个判断的下游是「要不要往这里写」。
 */
export class ResourceResolveError extends Error {
  constructor(public readonly target: string, public readonly cause: NodeJS.ErrnoException) {
    super(`无法解析 ${target} 的真实落点（${cause.syscall}: ${cause.code}）：`
      + "不能据此认定它属于哪套资源，请恢复该路径可读取后重试");
    this.name = "ResourceResolveError";
  }
}

/** 解析得了就给落点，**确实不存在**给 null，读不动抛 `ResourceResolveError`。 */
function realpathOrAbsent(target: string): string | null {
  try {
    return realpathSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new ResourceResolveError(target, error as NodeJS.ErrnoException);
  }
}

/**
 * 资源键的规范形式。
 *
 * 同一份资源经不同路径到达（软链、`..`、父目录别名、相对路径）时必须得出**同一个键**，
 * 否则两边各锁一个名字，等于没锁 —— 第 1 轮审查 F1 就是用「软链到同一份 runs」复现的。
 * 还不存在的路径（库文件第一次创建、runs 目录还没建）退一步解析父目录。
 */
export function canonicalResourceKey(path: string): string {
  const abs = resolve(path);
  const direct = realpathOrAbsent(abs);
  if (direct !== null) return direct;
  const parent = realpathOrAbsent(dirname(abs));
  return parent === null ? abs : join(parent, basename(abs));
}

/** 一套资源（库文件 + 它的 runs 目录）的全部键，去重并排序 —— 所有角色都要用这一组。 */
export function resourceKeysFor(dbFile: string, runsDir: string): string[] {
  return [...new Set([canonicalResourceKey(dbFile), canonicalResourceKey(runsDir)])].sort();
}

/**
 * 原子地「带着内容建一个新文件」。已经存在返回 false，不覆盖。
 *
 * `openSync(path, "wx")` 只保证文件原子出现，**内容是后写的**；`link()` 把一份写好的
 * 临时文件挂到目标名上，内容和存在性一起出现，所以绝不会被别人读到半份。
 */
export function atomicCreateWithContent(path: string, text: string, mode = 0o600,
  options: { fsync?: boolean } = {}): boolean {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  // 临时文件的写入也必须在 try 里:磁盘满 / I/O 错误会在 writeFileSync 中途抛，那时盘上
  // 可能已经留了半份 .tmp。清理放 finally，覆盖「写一半就抛」和「link 完」两条出口。
  try {
    writeFileSync(temp, text, { mode, flag: "wx" });
    if (options.fsync === true) {
      // 「原子出现」只对**别的进程**成立;要让这份内容在掉电之后还在，得在 link 之前刷一次。
      const handle = openSync(temp, "r");
      try {
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
    }
    linkSync(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    try {
      unlinkSync(temp);
    } catch { /* 已经被 link 走、或者压根没建起来 */ }
  }
}

/**
 * `path` 规范化之后还在 `root`（规范化之后）里面吗。
 *
 * **为什么不能只比字符串前缀**：隔离资源集里随便一级目录是条软链，字符串上它仍在
 * `root` 下，真实落点却在别人家 —— 第 3 轮审查 F1 就是用 `copy/runs/smoke ->
 * source/runs/smoke` 复现的：根目录那一关全过了，写进去的是源库的历史。
 *
 * 文件本身可能还不存在（备份、临时文件），所以规范化走 `canonicalResourceKey`：它解析
 * 得了就解析文件，解析不了就退一步解析父目录 —— 父目录是软链同样会被揭出来。
 */
export function withinResource(root: string, path: string): boolean {
  try {
    const base = canonicalResourceKey(root);
    const real = canonicalResourceKey(path);
    return real === base || real.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
  } catch (error) {
    // 「证明不了在里面」只能按**在外面**算。这一问的下游是「要不要往这里写」，答不上来还放行，
    // 失败方向就是往别人家的历史上写。
    if (error instanceof ResourceResolveError) return false;
    throw error;
  }
}

type ClaimBody = { pid: number; note: string; token: string; at: string; startedAtMs?: number };

const sleep = (ms: number) => {
  // 同步等待:取锁这条路上下游全是同步代码(服务启动、CLI 起手),不能改成 await。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function readClaim(file: string): ClaimBody | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ClaimBody>;
    if (typeof parsed.pid !== "number" || typeof parsed.token !== "string") return null;
    return parsed as ClaimBody;
  } catch {
    return null;
  }
}

/**
 * 这把占有锁还有主吗。
 *
 * **判据只有「持有者死了」，没有「它拿得太久了」**（第 3 轮审查 F2）：按墙钟抢锁等于
 * 规定「超过 N 秒的临界区可以被别人掀桌」—— 进程被 SIGSTOP、文件系统卡住、机器换页，
 * 都会让一个活得好好的持有者被判死，而它恢复之后还会接着跑完自己的回调，两边同时在写。
 * 活着又一直不放的，宁可把 `ResourceClaimError` 抛给人（错误里写了删哪个文件）。
 *
 * 读不懂的那种才看时间：锁是**带着内容原子出现**的，所以「读不懂」不可能是「刚建好还没
 * 写完」那一瞬，只可能是上一次留下的残骸；给点余量之后按残骸清掉。
 */
function staleClaim(file: string): boolean {
  const body = readClaim(file);
  if (body) {
    if (isPidAlive(body.pid)) {
      // pid 可能被复用了:启动时刻对不上就说明原主早就没了。
      if (typeof body.startedAtMs !== "number") return false;
      const info = inspectProcess(body.pid);
      if (info?.startedAtMs === null || info?.startedAtMs === undefined) return false;
      return Math.abs(info.startedAtMs - body.startedAtMs) > START_TIME_TOLERANCE_MS;
    }
    return true;
  }
  try {
    return Date.now() - statSync(file).mtimeMs > STALE_MS;
  } catch {
    return true; // 文件没了 = 没人占
  }
}

function describe(file: string): string {
  const body = readClaim(file);
  return body ? `PID ${body.pid}，${body.note}，起于 ${body.at}` : "内容读不出来";
}

function take(file: string, note: string): () => void {
  const token = randomUUID();
  const body: ClaimBody = {
    pid: process.pid,
    note,
    token,
    at: new Date().toISOString(),
    startedAtMs: Date.now() - Math.round(process.uptime() * 1000),
  };
  const deadline = Date.now() + BUDGET_MS;
  mkdirSync(dirname(file), { recursive: true });
  for (;;) {
    if (atomicCreateWithContent(file, JSON.stringify(body))) {
      return () => {
        if (readClaim(file)?.token !== token) return; // 已经被判成陈旧并换人了，别删别人的
        try {
          unlinkSync(file);
        } catch { /* 别人清了 */ }
      };
    }
    if (staleClaim(file)) {
      try {
        unlinkSync(file);
      } catch { /* 别人同时清了 */ }
      continue;
    }
    if (Date.now() >= deadline) throw new ResourceClaimError(file, describe(file));
    sleep(POLL_MS);
  }
}

/**
 * 在这套资源的占有锁里跑一段「查对方 + 建自己的长命锁」。
 *
 * `keys` 是这套资源的全部键（库文件路径、runs 目录路径……）；去重并排序之后依次取，
 * **所有角色都必须用同一组键**，否则等于没锁。
 */
export function withResourceClaim<T>(keys: readonly string[], note: string, run: () => T): T {
  const files = [...new Set(keys.map(claimFileFor))].sort();
  const releases: (() => void)[] = [];
  try {
    for (const file of files) releases.push(take(file, note));
    return run();
  } finally {
    for (const release of releases.reverse()) release();
  }
}
