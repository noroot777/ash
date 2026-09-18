// 终端会话清场要面对的硬事实:交互 shell 开着 job control(monitor mode)时,每个后台
// 作业(`cmd &`)会被 setpgid 进**独立进程组**(pgid == 作业领头进程 pid),`kill(-shellpgid)`
// 够不着它们。若作业忽略 HUP/TERM、shell 又先 exit,作业就被 PID 1 收养、ppid 树的线索
// 当场断掉 —— 只看 shell 原 pgid 的存活判断会把它当成「已清空」,实则还在跑、还占着端口
// (第 2 轮自由审查实锤)。
//
// 对策分两半:
//   ① 发信号前**实时**抓一次后代快照(shell 还活着时能抓到);
//   ② 会话存续期**持续累积**见过的后代 pgid(shell 死后树断了,只能靠这份内存快照)。
// 这个文件只放纯函数(探活 + 读进程表 + 从表里挖后代),累积与信号逻辑在 terminal.ts。
//
// 为什么不按 SID/会话枚举孤儿(第 3 轮审查建议,macOS 上实测走不通):
//   - `ps -o sess=`:BSD 的会话指针,SIP 下对非 root 一律抹成 0,拿不到会话身份;
//   - `ps -o sid=`:macOS 的 ps 根本没有这个数字 keyword;
//   - 控制 tty:session leader(pty 里的 shell)一 exit 就被吊销,孤儿的 tt 变成 "??";
//   - `pgrep -s`:macOS 不支持 `-s`。
// 结论:shell 退出后,userspace 没有任何一条线索能把独立组孤儿关联回原 pty 会话。真正
// 的残留 = 后台作业启动**又**在任一次扫描(周期 + onData 触发)落地前关掉 shell —— 那一个
// pgid 从没被记下、shell 也没了,本层无从下手,超出能力,如实记录(见 terminal.ts
// trackDescendants)。彻底消除需 OS 级 containment(Linux 的 subreaper/cgroup),macOS 无解。
import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { IS_WINDOWS } from "./platform.js";

const execFileAsync = promisify(execFile);
const PS_ARGS = ["-axo", "pid=,ppid=,pgid="];

export type DescendantSnapshot = { pids: number[]; pgids: number[] };
export type ProcessTable = { children: Map<number, number[]>; pgidOf: Map<number, number> };

/** 进程组里还有没有活人:信号 0 只探测不打扰,整组已空时抛 ESRCH。Windows 没有进程组。 */
export function groupAlive(groupId: number): boolean {
  if (IS_WINDOWS) return false;
  try { process.kill(-groupId, 0); return true; } catch { return false; }
}

/** 单个进程还在不在:信号 0 探测,已死抛 ESRCH。 */
export function processAlive(pid: number): boolean {
  if (IS_WINDOWS) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function parseProcessTable(stdout: string): ProcessTable {
  const children = new Map<number, number[]>();
  const pgidOf = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (!pid || Number.isNaN(ppid) || Number.isNaN(pgid)) continue;
    pgidOf.set(pid, pgid);
    const siblings = children.get(ppid) ?? [];
    siblings.push(pid);
    children.set(ppid, siblings);
  }
  return { children, pgidOf };
}

/**
 * 一次 `ps` 抓全系统进程表(pid→children、pid→pgid),给一轮里多个会话共用 —— 持续累积
 * 时 N 个会话只跑一次 ps。ps 不可用(容器/极简环境)返回 null,调用方退回「只杀组长组」
 * 的原有行为。
 */
export async function readProcessTable(): Promise<ProcessTable | null> {
  if (IS_WINDOWS) return null;
  try {
    const { stdout } = await execFileAsync("ps", PS_ARGS);
    return parseProcessTable(stdout);
  } catch {
    return null;
  }
}

/** readProcessTable 的同步版:退出钩子(shutdown)和 close() 里没有 await,只能同步跑 ps。 */
export function readProcessTableSync(): ProcessTable | null {
  if (IS_WINDOWS) return null;
  try {
    return parseProcessTable(execFileSync("ps", PS_ARGS, { encoding: "utf8" }));
  } catch {
    return null;
  }
}

/**
 * 从进程表里挖出 rootPid 的全部后代(pid)与它们**自己的进程组**(pgid)。pgid ≤ 1 一律
 * 不收:`kill(-1)` 是「向所有能杀的进程广播」,绝不能碰;pgid === rootPid 是组长自己的组,
 * 调用方另发。child ≤ 1(理论上不会有,防御 ps 脏数据)也跳过。
 */
export function descendantsFromTable(table: ProcessTable, rootPid: number): DescendantSnapshot {
  const pids: number[] = [];
  const pgids = new Set<number>();
  const queue = [rootPid];
  while (queue.length) {
    for (const child of table.children.get(queue.shift()!) ?? []) {
      if (child <= 1) continue;
      pids.push(child);
      const pgid = table.pgidOf.get(child);
      if (pgid !== undefined && pgid > 1 && pgid !== rootPid) pgids.add(pgid);
      queue.push(child);
    }
  }
  return { pids, pgids: [...pgids] };
}

/**
 * rootPid 的后代快照。必须在**发信号之前**抓:组长一死后代就被 PID 1 收养,ppid 树的
 * 线索当场断掉(macOS 实测:收养后 tty 被吊销、无 sid 列可查,userspace 再也关联不回原
 * pty 会话)——所以「shell 还活着时」的实时快照是主力,shell 已退出的只能靠会话存续期
 * 累积的 pgid(见 terminal.ts)。ps 不可用时退回空快照(= 只杀组长的组)。
 */
export async function snapshotDescendants(rootPid: number): Promise<DescendantSnapshot> {
  const table = await readProcessTable();
  return table ? descendantsFromTable(table, rootPid) : { pids: [], pgids: [] };
}

/** snapshotDescendants 的同步版(shutdown/close 用)。 */
export function snapshotDescendantsSync(rootPid: number): DescendantSnapshot {
  const table = readProcessTableSync();
  return table ? descendantsFromTable(table, rootPid) : { pids: [], pgids: [] };
}
