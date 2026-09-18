// 终端会话清场要面对的硬事实:交互 shell 开着 job control(monitor mode)时,每个后台
// 作业(`cmd &`)会被 setpgid 进**独立进程组**(pgid == 作业领头进程 pid),`kill(-shellpgid)`
// 够不着它们。若作业忽略 HUP/TERM、shell 又先 exit,作业就被 PID 1 收养、ppid 树的线索
// 当场断掉 —— 只看 shell 原 pgid 的存活判断会把它当成「已清空」,实则还在跑、还占着端口
// (第 2 轮自由审查实锤)。
//
// 对策分三层(可靠性从高到低):
//   ① 交互会话的 TTY_REAPER_WRAPPER:session leader 常驻,shell 退出时确定性清杀(见下);
//   ② 结束/关服路径的实时快照:ppid 树 + tty 持有者(leader 活着时确定性);
//   ③ 会话存续期**持续累积**见过的后代 pgid(①② 都不可用时的降级线索)。
// 这个文件只放纯函数与 wrapper 脚本(探活 + 读进程表 + 挖后代 + 枚举 tty 持有者),
// 累积与信号逻辑在 terminal.ts。
//
// 为什么不按 SID/会话枚举孤儿(第 3 轮审查建议,macOS 上实测走不通):
//   - `ps -o sess=`:BSD 的会话指针,SIP 下对非 root 一律抹成 0,拿不到会话身份;
//   - `ps -o sid=`:macOS 的 ps 根本没有这个数字 keyword;
//   - 控制 tty:session leader(pty 里的 shell)一 exit,XNU 直接 **revoke 整个会话所有
//     进程的 tty fd**(第 4 轮实测:孤儿 fd 表里连 tty 行都消失,lsof 无从关联)——so 事后
//     连「谁还握着这个 pty」都查不到;
//   - `pgrep -s`:macOS 不支持 `-s`。
// 结论:session leader 退出之后,userspace 没有任何一条线索能把独立组孤儿关联回原 pty
// 会话。所以对交互会话反过来做(第 4 轮):**别让用户 shell 当 session leader** ——
// pty 直接子进程是 TTY_REAPER_WRAPPER(常驻 /bin/sh),用户 shell 是它的孩子。用户 shell
// 无论怎么退,leader 还活着、revoke 未发生,wrapper 在退出前用 `lsof -t $(tty)` **确定性**
// 枚举全部余党并 TERM→KILL 清杀,再以内层退出码退出。这不依赖任何采样命中。manager 侧
// (terminate/close/shutdown)在 leader 活着时也用同一枚举补抓(ttyHolderPids),封住
// 「manager 在 wrapper 清杀中途把 wrapper 杀掉」的竞态。仅剩的真实残留:双 fork +
// 关全部 tty fd 的**真 daemon**(不持 tty,枚举不到)——那是刻意脱离终端的合法形状,
// 与 Terminal.app/VSCode 行为一致,如实记录。
import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
 * 调用方另发。child ≤ 1(理论上不会有,防御 ps 脏数据)也跳过。必须在**发信号之前**挖:
 * 组长一死后代就被 PID 1 收养,ppid 树的线索当场断掉。
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
 * 交互会话的 containment wrapper(文件顶部注释「对策」的第 4 轮升级)。作为 pty 的直接
 * 子进程(= session leader)常驻,内层用户 shell 经 "$@" 起($0 占位、$1.. 是 shell 与
 * 参数)。内层 shell 退出(任意方式,含 kill -9)后 leader 仍活、revoke 未发生,此时
 * `lsof -t $(tty)` 是**确定性**的会话成员清单 —— 对余党 TERM→0.2s→KILL(逐 pid + 逐
 * 进程组,防重定向了 stdio 的组员漏杀),然后以内层退出码退出。
 *
 * 两个硬性排除,少一个都出事故:
 *   - `$$`(wrapper 自己):不排除就自杀,清杀中断;
 *   - `$ASH_PTY_PARENT`(ash server):macOS 的 lsof 把 pty **master** 端也解析成同一个
 *     /dev/ttysN 名字,持有全部 master 的 server 会出现在每个会话的清单里 —— 探针实测
 *     不排除会把 server 整个 TERM 掉(probe4,exit 143)。
 *
 * lsof 不存在(极简容器)时整段跳过,退回 terminal.ts 的采样 + 快照兜底。`kill -s ... --`
 * 的 `--` 让负 pgid 不被当成选项(dash/bash3.2 通吃)。
 */
export const TTY_REAPER_WRAPPER = `"$@"
code=$?
t=$(tty 2>/dev/null)
if [ -n "$t" ] && command -v lsof >/dev/null 2>&1; then
  rest=""
  for p in $(lsof -t "$t" 2>/dev/null); do
    [ "$p" = "$$" ] && continue
    [ -n "$ASH_PTY_PARENT" ] && [ "$p" = "$ASH_PTY_PARENT" ] && continue
    rest="$rest $p"
  done
  if [ -n "$rest" ]; then
    for p in $rest; do
      kill -s TERM -- "$p" 2>/dev/null
      g=$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')
      [ -n "$g" ] && [ "$g" -gt 1 ] && kill -s TERM -- "-$g" 2>/dev/null
    done
    sleep 0.2
    for p in $rest; do
      kill -s KILL -- "$p" 2>/dev/null
      g=$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')
      [ -n "$g" ] && [ "$g" -gt 1 ] && kill -s KILL -- "-$g" 2>/dev/null
    done
  fi
fi
exit $code`;

function parseHolderPids(stdout: string): number[] {
  // 排除 server 自己(持有全部 pty master,macOS lsof 把 master 也解析成 /dev/ttysN,
  // 见 TTY_REAPER_WRAPPER 注释)与非法 pid。
  return [...new Set(stdout.split("\n").map((line) => Number(line.trim()))
    .filter((pid) => pid > 1 && pid !== process.pid))];
}

/**
 * 「谁还握着这些 pty slave」:session leader 活着时的**确定性**会话成员清单(不依赖
 * ppid 树,disown 后照样在列)。返回 null = 无法枚举(lsof 缺失,或 leader 已退、fd 已
 * 被 revoke、路径已回收)——调用方退回已知清单(快照 + 累积)判定,**不要**把 null 当
 * 「确证无人」。已消失的路径先过滤掉:revoke 后本来就不可枚举,还会让 lsof 刷 usage
 * 噪音到 stderr。lsof 无匹配时退 1 但 stdout 可信:能解析出 pid 就用,否则 null。
 */
export async function ttyHolderPids(ttyPaths: string[]): Promise<number[] | null> {
  const paths = IS_WINDOWS ? [] : ttyPaths.filter((path) => existsSync(path));
  if (!paths.length) return null;
  try {
    const { stdout } = await execFileAsync("lsof", ["-t", ...paths]);
    return parseHolderPids(stdout);
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (typeof stdout === "string" && stdout.trim()) return parseHolderPids(stdout);
    return null;
  }
}

/** ttyHolderPids 的同步版(close/shutdown 没有 await)。stderr 收进管道,别刷进服务日志。 */
export function ttyHolderPidsSync(ttyPaths: string[]): number[] | null {
  const paths = IS_WINDOWS ? [] : ttyPaths.filter((path) => existsSync(path));
  if (!paths.length) return null;
  try {
    return parseHolderPids(execFileSync("lsof", ["-t", ...paths], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch (error) {
    const stdout = (error as { stdout?: string | Buffer }).stdout;
    const text = typeof stdout === "string" ? stdout : stdout?.toString() ?? "";
    if (text.trim()) return parseHolderPids(text);
    return null;
  }
}
