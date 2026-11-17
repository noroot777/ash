// 可引导单飞回合的 stdin 具名管道（POSIX）：`<rc>.stdin.fifo`。它的寿命跟着这一轮的根 shell
// 走 —— server 只在根还活着时重开它（spawn 当场、重启后 reattach），根一走这个路径就再没人用。
//
// 原先只靠 shell 自己的 `trap … EXIT` 删：回合收台、停止、清理都是给整个进程组发信号，SIGKILL
// 下 trap 根本不跑，于是每轮留一根，攒在 data/runs 里，连带着让按文件复制 data/ 的地方（mac 版
// 的导入）碰上就失败。现在**所有删除都走这里**：根退出时收一次，启动时（run-logs-gc）再扫一遍
// 上一辈子没来得及收的。
//
// **判据：确认一个持有者都没有才删，拿不准就留着。**分两步问，两步都答「没有」才算：
//  ① 有没有读端 —— 以 O_WRONLY|O_NONBLOCK 打开，内核回 ENXIO 就是没有。这一问对**任何用户**的
//    进程都成立，而且不用列进程：根 shell 的 `3<>`、CLI 的 stdin、server 的 `r+` writer 都带读端。
//    探测本身只开不写，关掉它也不会给读端送 EOF（读端自己就占着写端）。
//  ② 有没有只写的持有者 —— ENXIO 证明不了这个（审查第 1 轮 F1 实测：读端全关、只剩一个 O_WRONLY
//    描述符时 ①答「没有」）。只能把进程打开的文件列出来，按 inode 比对。能列出来的只有本用户的
//    进程，所以先看权限位：组/其他人有写权限时别的用户也可能只写开着它，看不到 ⇒ 留着。root 绕过
//    权限位、非 root 也看不见它，那一类不在这里能答的范围之内。
// 列不出来（命令不在、失败、带了警告、记录不完整、平台没有办法）一律当「拿不准」。
import { execFile, spawnSync } from "node:child_process";
import { closeSync, constants, lstatSync, openSync, readdirSync, statSync, unlinkSync, type Stats } from "node:fs";
import { IS_WINDOWS } from "../platform.js";

export const CONTROL_FIFO_SUFFIX = ".agent-rc.stdin.fifo";

export const controlFifoPath = (rc: string) => `${rc}.stdin.fifo`;

export type FifoSweep = "removed" | "busy" | "absent" | "unknown";

const errCode = (err: unknown) => (err as NodeJS.ErrnoException).code;

type Probe = { kind: "done"; result: FifoSweep } | { kind: "noReader"; st: Stats };

/** 第①步，外加「这是不是我们能答的那种 FIFO」。 */
function probe(path: string): Probe {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch (err) {
    return { kind: "done", result: errCode(err) === "ENOENT" ? "absent" : "unknown" };
  }
  if (!st.isFIFO()) return { kind: "done", result: "unknown" };
  if ((st.mode & 0o022) !== 0 || st.uid !== process.getuid?.()) return { kind: "done", result: "unknown" };
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
    return { kind: "done", result: "busy" };
  } catch (err) {
    return errCode(err) === "ENXIO" ? { kind: "noReader", st } : { kind: "done", result: "unknown" };
  }
}

/**
 * 第②步：本用户的进程此刻开着的 FIFO 的 inode。null = 列不全。
 * macOS 的 `lsof <路径>` 认不出 FIFO（有人开着也答没有，实测），所以列全部再自己比；FIFO 记录不带
 * 设备号，只按 inode 比 —— 别的卷上撞号只会多判「有人开着」，方向是保守的。
 */
async function heldFifoInodes(): Promise<Set<number> | null> {
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  if (process.platform === "linux") return procFdInodes(uid);
  if (process.platform !== "darwin") return null;
  return parseLsof(await new Promise<{ ok: boolean; out: string }>((resolve) => {
    execFile("lsof", lsofArgs(uid), { maxBuffer: LSOF_BUFFER }, (err, out, warn) => {
      resolve({ ok: !err && !String(warn).trim(), out: String(out) });
    });
  }));
}

/** 同上，同步版：只给起跑前「同一路径居然已经在了」那条罕见路用，平时不付这 0.2 秒的阻塞。 */
function heldFifoInodesSync(): Set<number> | null {
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  if (process.platform === "linux") return procFdInodes(uid);
  if (process.platform !== "darwin") return null;
  const r = spawnSync("lsof", lsofArgs(uid), { maxBuffer: LSOF_BUFFER });
  return parseLsof({ ok: r.status === 0 && !r.error && !String(r.stderr).trim(), out: String(r.stdout) });
}

const LSOF_BUFFER = 256 << 20;
const lsofArgs = (uid: number) => ["-n", "-P", "-F", "fti", "-u", String(uid)];

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

type Candidate = { path: string; st: Stats };

function firstStep(paths: readonly string[], results: Map<string, FifoSweep>): Candidate[] {
  const candidates: Candidate[] = [];
  for (const path of paths) {
    if (IS_WINDOWS) { results.set(path, "unknown"); continue; }
    const first = probe(path);
    if (first.kind === "done") results.set(path, first.result);
    else candidates.push({ path, st: first.st });
  }
  return candidates;
}

/** 一批一起问：第②步整机只列一次。 */
export async function removeIdleControlFifos(paths: readonly string[]): Promise<Map<string, FifoSweep>> {
  const results = new Map<string, FifoSweep>();
  const candidates = firstStep(paths, results);
  if (candidates.length) secondStep(candidates, await heldFifoInodes(), results);
  return results;
}

export async function removeIdleControlFifo(path: string): Promise<FifoSweep> {
  return (await removeIdleControlFifos([path])).get(path) ?? "unknown";
}

export function removeIdleControlFifoSync(path: string): FifoSweep {
  const results = new Map<string, FifoSweep>();
  const candidates = firstStep([path], results);
  if (candidates.length) secondStep(candidates, heldFifoInodesSync(), results);
  return results.get(path) ?? "unknown";
}

function secondStep(candidates: Candidate[], held: Set<number> | null, results: Map<string, FifoSweep>): void {
  for (const { path, st } of candidates) {
    if (!held) { results.set(path, "unknown"); continue; }
    if (held.has(st.ino)) { results.set(path, "busy"); continue; }
    // 路径上还是刚才问过的那一个才删（中间被换掉的不碰）。
    try {
      const now = lstatSync(path);
      if (now.dev !== st.dev || now.ino !== st.ino) { results.set(path, "unknown"); continue; }
      unlinkSync(path);
      results.set(path, "removed");
    } catch (err) {
      results.set(path, errCode(err) === "ENOENT" ? "absent" : "unknown");
    }
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
