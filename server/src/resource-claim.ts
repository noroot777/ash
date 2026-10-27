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
import { linkSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isPidAlive } from "./platform.js";

const CLAIM_SUFFIX = ".ash-claim.lock";
/** 占有锁只在「查对方 + 建自己」那几毫秒里被持有，所以等 3 秒还拿不到就是真有人在抢。 */
const BUDGET_MS = 3_000;
const POLL_MS = 25;
/** 比这更老的占有锁一定是持有者死在中途了（正常持有期是毫秒级）。 */
const STALE_MS = 30_000;

export class ResourceClaimError extends Error {
  constructor(public readonly claimFile: string, public readonly holder: string) {
    super(`这套资源正被另一个进程占着起手动作（${holder}）：${claimFile}\n`
      + "这把锁只该持有几毫秒；若它一直不放，确认那个进程已经不在之后删掉它。");
    this.name = "ResourceClaimError";
  }
}

export const claimFileFor = (key: string): string => `${key}${CLAIM_SUFFIX}`;

/**
 * 资源键的规范形式。
 *
 * 同一份资源经不同路径到达（软链、`..`、父目录别名、相对路径）时必须得出**同一个键**，
 * 否则两边各锁一个名字，等于没锁 —— 第 1 轮审查 F1 就是用「软链到同一份 runs」复现的。
 * 还不存在的路径（库文件第一次创建、runs 目录还没建）退一步解析父目录。
 */
export function canonicalResourceKey(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    try {
      return join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
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
export function atomicCreateWithContent(path: string, text: string, mode = 0o600): boolean {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, { mode });
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    try {
      unlinkSync(temp);
    } catch { /* 已经被 link 走或别人清了，无所谓 */ }
  }
}

type ClaimBody = { pid: number; note: string; token: string; at: string };

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

/** 这把占有锁还有主吗。读不懂的只按「老得不合理」判陈旧，不当场抢。 */
function staleClaim(file: string): boolean {
  const body = readClaim(file);
  if (body && !isPidAlive(body.pid)) return true;
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
  const body: ClaimBody = { pid: process.pid, note, token, at: new Date().toISOString() };
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
