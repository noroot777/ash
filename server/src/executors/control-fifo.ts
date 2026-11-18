// 可引导单飞回合的 stdin 具名管道（POSIX）：`<rc>.stdin.fifo`。它的寿命跟着这一轮的根 shell
// 走 —— server 只在根还活着时重开它（spawn 当场、重启后 reattach），根一走这个路径就再没人用。
//
// 原先只靠 shell 自己的 `trap … EXIT` 删：回合收台、停止、清理都是给整个进程组发信号，SIGKILL
// 下 trap 根本不跑，于是每轮留一根，攒在 data/runs 里，连带着让按文件复制 data/ 的地方（mac 版
// 的导入）碰上就失败。现在**所有删除都走这里**：根退出时收一次，启动时（run-logs-gc）再扫一遍
// 上一辈子没来得及收的。
//
// **判据：确认一个持有者都没有才删，拿不准就留着。**
//
// 「查完没人开着」和「删掉」之间天然有空档 —— POSIX 没有「没人开着才删」的一步式操作，查完之后
// 有人按原路径打开、再删，删的就是一根有人在用的管子（审查第 2 轮 F1 实测）。所以先**改名挪开**
// （同目录 rename，原子）再查：挪开之后谁都没法再按原路径打开它，查到的就是定论。查完：
//  · 没人开着 → 删掉挪开的那个名字；
//  · 有人开着 / 拿不准 → 改回原名（link 回去，原名上已有别的东西就不覆盖、留在挪开的名字上）。
// 代价（用户 2026-11-17 选定）：恰好在这零点几秒里按原路径打开它的程序会扑空一次。ash 自己的
// 两处重开不会撞上：spawn 用的是这一轮新建的路径；reattach 只在根还活着时重开，而活着的根
// 用 `3<>` 一直占着读端，下面第①问当场答「有人」，根本走不到改名那一步。
//
// 「有没有人开着」分两问，都答「没有」才算：
//  ① 有没有读端 —— 以 O_WRONLY|O_NONBLOCK 打开，内核回 ENXIO 就是没有。对**任何用户**的进程都
//    成立：根 shell 的 `3<>`、CLI 的 stdin、server 的 `r+` writer 都带读端。探测只开不写，关掉它
//    也不会给读端送 EOF（读端自己就占着写端）。改名前后各问一次。
//  ② 有没有只写的持有者 —— ENXIO 证明不了这个（审查第 1 轮 F1）。只能把进程开着的文件列出来按
//    inode 比。能列出来的只有本用户的进程，所以权限位必须只许属主写（新建的一律 600）；组/其他人
//    可写 ⇒ 留着。**看不见的两类**：root（绕过权限位，非 root 也列不到它），以及在权限收紧之前
//    就已经开着它的其他用户 —— 这两类不在这里能答的范围之内。
// 列不出来（命令不在、失败、超时、带了警告、记录不完整、平台没有办法）一律当「拿不准」。
import { readEnv } from "@ash/shared/env-names";
import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync, constants, linkSync, lstatSync, openSync, readdirSync, renameSync, statSync, unlinkSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { IS_WINDOWS } from "../platform.js";

export const CONTROL_FIFO_SUFFIX = ".agent-rc.stdin.fifo";

export const controlFifoPath = (rc: string) => `${rc}.stdin.fifo`;

export type FifoSweep = "removed" | "busy" | "absent" | "unknown";

/** 挪开时的名字：`<原名>.retiring-<pid>-<随机>`。进程中途死掉留下的，启动那一扫按 pid 认回去。 */
const RETIRING = ".retiring-";
const retiringName = (path: string) =>
  join(dirname(path), `${basename(path)}${RETIRING}${process.pid}-${randomBytes(4).toString("hex")}`);

// 进程表最多等这么久；超时 = 列不全 = 留着（同步那条路上也就最多卡这么久）。环境变量只给测试用。
const LIST_TIMEOUT_MS = Number(readEnv(process.env, "NAVI_FIFO_LIST_TIMEOUT_MS")) || 10_000;
const LSOF_BUFFER = 256 << 20;
const lsofArgs = (uid: number) => ["-n", "-P", "-F", "fti", "-u", String(uid)];

const errCode = (err: unknown) => (err as NodeJS.ErrnoException).code;
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

/** 第①问。true = 有读端，false = 没有，null = 答不上来。 */
function hasReader(path: string): boolean | null {
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
    return true;
  } catch (err) {
    return errCode(err) === "ENXIO" ? false : null;
  }
}

/** 第②问：本用户的进程此刻开着的 FIFO 的 inode。null = 列不全。 */
async function heldFifoInodes(): Promise<Set<number> | null> {
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  if (process.platform === "linux") return procFdInodes(uid);
  if (process.platform !== "darwin") return null;
  return parseLsof(await new Promise<{ ok: boolean; out: string }>((resolve) => {
    execFile("lsof", lsofArgs(uid), { maxBuffer: LSOF_BUFFER, timeout: LIST_TIMEOUT_MS, killSignal: "SIGKILL" },
      (err, out, warn) => resolve({ ok: !err && !String(warn).trim(), out: String(out) }));
  }));
}

/** 同上，同步版：只给起跑前「同一路径居然已经在了」那条罕见路用。 */
function heldFifoInodesSync(): Set<number> | null {
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  if (process.platform === "linux") return procFdInodes(uid);
  if (process.platform !== "darwin") return null;
  const r = spawnSync("lsof", lsofArgs(uid), { maxBuffer: LSOF_BUFFER, timeout: LIST_TIMEOUT_MS, killSignal: "SIGKILL" });
  return parseLsof({ ok: r.status === 0 && !r.error && !String(r.stderr).trim(), out: String(r.stdout) });
}

/**
 * macOS 的 `lsof <路径>` 认不出 FIFO（有人开着也答没有，实测），所以列全部再自己比；FIFO 记录不带
 * 设备号，只按 inode 比 —— 别的卷上撞号只会多判「有人开着」，方向是保守的。
 */
function parseLsof(listed: { ok: boolean; out: string }): Set<number> | null {
  if (!listed.ok) return null;
  const held = new Set<number>();
  let type: string | null = null;
  let inode: string | null = null;
  const flush = () => {
    if (type === "FIFO") held.add(inode === null ? NaN : Number(inode));
    type = inode = null;
  };
  for (const line of listed.out.split("\n")) {
    if (line[0] === "p" || line[0] === "f" || line === "") flush();
    else if (line[0] === "t") type = line.slice(1);
    else if (line[0] === "i") inode = line.slice(1);
  }
  flush();
  return [...held].some((n) => !Number.isSafeInteger(n)) ? null : held;
}

/** Linux：逐个读本用户进程的 /proc/<pid>/fd。读不了自己用户的那一份就是列不全。 */
function procFdInodes(uid: number): Set<number> | null {
  const held = new Set<number>();
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    let fds: string[];
    try {
      if (statSync(`/proc/${pid}`).uid !== uid) continue;
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch (err) {
      if (errCode(err) === "ENOENT" || errCode(err) === "ESRCH") continue; // 进程刚走
      return null;
    }
    for (const fd of fds) {
      try {
        const st = statSync(`/proc/${pid}/fd/${fd}`);
        if (st.isFIFO()) held.add(st.ino);
      } catch (err) {
        if (errCode(err) !== "ENOENT") return null;
      }
    }
  }
  return held;
}

/** 已经挪开、等第②问的那一根。 */
type Parked = { path: string; parked: string; st: Stats };

// 同一个进程里两处同时收同一根（根退出那一收和启动那一扫碰上）：后来的那个直接答「拿不准」，
// 交给先到的那个。
const inFlight = new Set<string>();

/** 改名之前的部分：是不是我们能答的那种 FIFO、有没有读端；都过了就挪开。 */
function park(path: string, results: Map<string, FifoSweep>): Parked | null {
  const done = (result: FifoSweep) => { results.set(path, result); return null; };
  if (IS_WINDOWS || inFlight.has(path)) return done("unknown");
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch (err) {
    return done(errCode(err) === "ENOENT" ? "absent" : "unknown");
  }
  if (!st.isFIFO()) return done("unknown");
  if ((st.mode & 0o022) !== 0 || st.uid !== process.getuid?.()) return done("unknown");
  const reader = hasReader(path);
  if (reader !== false) return done(reader ? "busy" : "unknown");
  const parked = retiringName(path);
  try {
    renameSync(path, parked);
  } catch (err) {
    return done(errCode(err) === "ENOENT" ? "absent" : "unknown");
  }
  inFlight.add(path);
  const entry = { path, parked, st };
  // 挪走的必须还是刚才问过的那一根；改名前一刻被换掉了就原样放回。
  try {
    if (sameFile(lstatSync(parked), st)) return entry;
  } catch { /* 落到下面放回 */ }
  settle(entry, "unknown", results);
  return null;
}

/** 收尾：没人开着就删挪开的名字，否则放回原名。 */
function settle(entry: Parked, verdict: "remove" | "busy" | "unknown", results: Map<string, FifoSweep>): void {
  const { path, parked } = entry;
  try {
    if (verdict === "remove") {
      try {
        unlinkSync(parked);
        results.set(path, "removed");
      } catch {
        results.set(path, "unknown");
        restore(path, parked);
      }
      return;
    }
    results.set(path, verdict);
    restore(path, parked);
  } finally {
    inFlight.delete(path);
  }
}

/** link 回原名（原名上已有东西时失败、不覆盖），再去掉挪开的名字。放不回去就留在挪开的名字上。 */
function restore(path: string, parked: string): void {
  try {
    linkSync(parked, path);
  } catch {
    return;
  }
  try { unlinkSync(parked); } catch { /* 两个名字指着同一根，留着也无害 */ }
}

/** 改名之后的部分：再问一次读端（挪开之前就开着、刚才没碰上的），再按 inode 比进程表。 */
function decide(entries: Parked[], held: Set<number> | null, results: Map<string, FifoSweep>): void {
  for (const entry of entries) {
    const reader = hasReader(entry.parked);
    if (reader !== false) settle(entry, reader ? "busy" : "unknown", results);
    else if (!held) settle(entry, "unknown", results);
    else settle(entry, held.has(entry.st.ino) ? "busy" : "remove", results);
  }
}

/** 一批一起收：整批挪开之后进程表只列一次。 */
export async function removeIdleControlFifos(paths: readonly string[]): Promise<Map<string, FifoSweep>> {
  const results = new Map<string, FifoSweep>();
  const parked = paths.map((path) => park(path, results)).filter((entry): entry is Parked => entry !== null);
  if (!parked.length) return results;
  let held: Set<number> | null = null;
  try {
    held = await heldFifoInodes();
  } finally {
    decide(parked, held, results);
  }
  return results;
}

export async function removeIdleControlFifo(path: string): Promise<FifoSweep> {
  return (await removeIdleControlFifos([path])).get(path) ?? "unknown";
}

export function removeIdleControlFifoSync(path: string): FifoSweep {
  const results = new Map<string, FifoSweep>();
  const entry = park(path, results);
  if (entry) {
    let held: Set<number> | null = null;
    try {
      held = heldFifoInodesSync();
    } finally {
      decide([entry], held, results);
    }
  }
  return results.get(path) ?? "unknown";
}

/**
 * 进程中途死掉、留在挪开名字上的那些（`<原名>.retiring-<pid>-<随机>`，pid 已不在）：先放回原名，
 * 放回去的交给调用方照常判。返回放回了的原名。原名上已有东西就不动。
 */
export function restoreAbandonedRetirements(dir: string, names: readonly string[]): string[] {
  const restored: string[] = [];
  for (const name of names) {
    const at = name.indexOf(`${CONTROL_FIFO_SUFFIX}${RETIRING}`);
    if (at < 0) continue;
    const pid = Number(name.slice(at + CONTROL_FIFO_SUFFIX.length + RETIRING.length).split("-")[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pidAlive(pid)) continue;
    const path = join(dir, name.slice(0, at + CONTROL_FIFO_SUFFIX.length));
    const parked = join(dir, name);
    try {
      linkSync(parked, path);
      unlinkSync(parked);
      restored.push(path);
    } catch { /* 原名上已有东西 / 已经没了：不动 */ }
  }
  return restored;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errCode(err) !== "ESRCH";
  }
}

/**
 * 根 shell 已经退出：先把 server 自己这一端关掉（它也算一个持有者），关完再按上面的判据收。
 * 还有别人开着（CLI 甩出去的后代还攥着 stdin）就留给下次启动的那一扫。best-effort，不抛。
 */
export function retireControlFifo(path: string, writer: NodeJS.WritableStream | null | undefined): void {
  const stream = writer as (NodeJS.WritableStream & { closed?: boolean; destroy?: () => void }) | null | undefined;
  const sweep = () => { removeIdleControlFifo(path).catch(() => {}); };
  if (!stream || stream.closed || typeof stream.destroy !== "function") return sweep();
  stream.once("close", sweep);
  stream.destroy();
}
