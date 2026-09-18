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
import { accessSync, constants, existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { promisify } from "node:util";
import { IS_WINDOWS } from "./platform.js";

const execFileAsync = promisify(execFile);
const PS_ARGS = ["-axo", "pid=,ppid=,pgid="];

/** Linux 的 procfs 可用:进程表 / tty 持有者都能**零外部命令**从 /proc 读,精简容器免疫
 *  「lsof/ps 没装」(scripts/platform.mjs 记录过 Rocky 容器踩坑)。macOS 没有 /proc。 */
export const HAS_PROC = !IS_WINDOWS && existsSync("/proc/self/stat");

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

/** /proc/<pid>/stat 括号后的字段:0=state 1=ppid 2=pgrp 3=session。comm 可含空格/括号,
 *  一律从**最后一个** ") " 之后切。 */
function procStatFields(stat: string): string[] {
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

/** Linux:直接读 /proc 建进程表,不依赖 ps(精简容器可能没有 procps)。 */
function procProcessTable(): ProcessTable | null {
  const children = new Map<number, number[]>();
  const pgidOf = new Map<number, number>();
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      try {
        const fields = procStatFields(readFileSync(`/proc/${entry}/stat`, "utf8"));
        const ppid = Number(fields[1]);
        const pgid = Number(fields[2]);
        if (Number.isNaN(ppid) || Number.isNaN(pgid)) continue;
        pgidOf.set(pid, pgid);
        const siblings = children.get(ppid) ?? [];
        siblings.push(pid);
        children.set(ppid, siblings);
      } catch { /* 进程在读表途中退出,跳过 */ }
    }
  } catch {
    return null;
  }
  return { children, pgidOf };
}

/**
 * 抓全系统进程表(pid→children、pid→pgid),给一轮里多个会话共用 —— 持续累积时 N 个
 * 会话只跑一次。Linux 走 /proc(零外部命令),其余 POSIX 走 ps;都不可用返回 null,
 * 调用方退回「只杀组长组」的原有行为。
 */
export async function readProcessTable(): Promise<ProcessTable | null> {
  if (IS_WINDOWS) return null;
  if (HAS_PROC) return procProcessTable();
  try {
    const { stdout } = await execFileAsync("ps", PS_ARGS);
    return parseProcessTable(stdout);
  } catch {
    return null;
  }
}

/** readProcessTable 的同步版:退出钩子(shutdown)和 close() 里没有 await。 */
export function readProcessTableSync(): ProcessTable | null {
  if (IS_WINDOWS) return null;
  if (HAS_PROC) return procProcessTable();
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
 * lsof 的**绝对路径**解析:PATH 逐目录找,找不到再试几处知名安装位 —— `/usr/sbin` 常常
 * 不在非交互 shell 的 PATH 里(scripts/platform.mjs 有同款教训),而 macOS 的 lsof 就装在
 * /usr/sbin。解析结果经 env `ASH_LSOF` 传给 wrapper、manager 侧枚举也用它,两边都不再
 * 依赖运行时 PATH(第 5 轮审查:PATH 去掉 /usr/sbin 就静默失去清场能力)。
 */
export function resolveLsofPath(
  pathEnv: string | undefined = process.env.PATH,
  fallbacks: string[] = ["/usr/sbin/lsof", "/usr/bin/lsof", "/opt/homebrew/bin/lsof"],
): string | null {
  if (IS_WINDOWS) return null;
  for (const dir of (pathEnv ?? "").split(":")) {
    if (!dir) continue;
    const candidate = `${dir}/lsof`;
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* 下一个 */ }
  }
  for (const candidate of fallbacks) {
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* 下一个 */ }
  }
  return null;
}

export const LSOF_PATH = resolveLsofPath();

/**
 * 终端 containment 依赖是否齐备:Linux 靠 /proc(零外部命令),其余 POSIX 靠 lsof。
 * 都没有就**不能承诺**「关会话时清空进程树」——终端 create 会显式拒绝(terminal.ts),
 * 绝不静默降级到已被证伪的采样后继续对清场报成功(第 5 轮审查)。
 */
export function containmentAvailable(): boolean {
  return !IS_WINDOWS && (HAS_PROC || LSOF_PATH !== null);
}

// ── wrapper 脚本 ────────────────────────────────────────────────────────────────
// 共享 prelude:ash_lsof 解析 lsof(env ASH_LSOF 绝对路径优先,再 PATH,再 /usr/sbin);
// ash_members 产出 "pid:pgid " 清单 —— Linux 扫 /proc/*/fd(零外部命令,pgid 直接读
// stat 第 3 字段),其余用 lsof + ps。两个硬性排除,少一个都出事故:
//   - `$$`(wrapper 自己):不排除就自杀,清杀中断;
//   - `$ASH_PTY_PARENT`(ash server):macOS 的 lsof 把 pty **master** 端也解析成同一个
//     /dev/ttysN 名字,持有全部 master 的 server 会出现在每个会话的清单里 —— 探针实测
//     不排除会把 server 整个 TERM 掉(probe4,exit 143)。
// lsof 分支的两道防呆(实测各卡死过一次 KEEPER 等待循环):命令替换的**中间 subshell**
// 在 lsof 扫描期间还握着 wrapper 的 tty(fd0/2),重定向绑在 lsof 上救不了它 —— 所以子
// shell 里先 `exec` 重定向自身;以及 pgid 查不到(ps 输出为空)的命中一律跳过 —— 那是
// 已死的瞬时进程(subshell / 枚举工具自己),不算成员,真成员恰在间隙死掉也无需再管。
const WRAPPER_PRELUDE = `ash_lsof() {
  L="$ASH_LSOF"
  [ -x "$L" ] || L="$(command -v lsof 2>/dev/null)"
  [ -x "$L" ] || L=/usr/sbin/lsof
  [ -x "$L" ] || L=""
}
ash_members() {
  MEMBERS=""
  if [ -d /proc/self/fd ]; then
    for d in /proc/[0-9]*; do
      p="\${d#/proc/}"
      [ "$p" = "$$" ] && continue
      [ -n "$ASH_PTY_PARENT" ] && [ "$p" = "$ASH_PTY_PARENT" ] && continue
      [ -n "$T" ] || continue
      ls -l "$d/fd" 2>/dev/null | grep -q -- "-> $T\\$" || continue
      s="$(cat "$d/stat" 2>/dev/null)" || continue
      r="\${s##*) }"
      set -- $r
      MEMBERS="$MEMBERS$p:$3 "
    done
  elif [ -n "$T" ] && [ -n "$L" ]; then
    for p in $(exec </dev/null 2>/dev/null; "$L" -t "$T"); do
      [ "$p" = "$$" ] && continue
      [ -n "$ASH_PTY_PARENT" ] && [ "$p" = "$ASH_PTY_PARENT" ] && continue
      g="$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')"
      [ -n "$g" ] || continue
      MEMBERS="$MEMBERS$p:$g "
    done
  fi
}
`;

/**
 * 交互会话的 containment wrapper。作为 pty 的直接子进程(= session leader)常驻,内层
 * 用户 shell 经 "$@" 起($0 占位、$1.. 是 shell 与参数)。内层 shell 退出(任意方式,含
 * kill -9)后 leader 仍活、revoke 未发生,此刻的成员枚举是**确定性**的 —— 对余党
 * TERM→0.2s→重枚举→KILL(逐 pid + 逐进程组,防重定向了 stdio 的组员漏杀),然后以内层
 * 退出码退出。不依赖任何采样命中(第 4 轮);枚举机制不可用时(排查过的真实场景只剩
 * 「非 Linux 且 lsof 缺失」)manager 的 create 已拒绝开会话,不会走到这里。
 */
export const TTY_REAPER_WRAPPER = `${WRAPPER_PRELUDE}"$@"
code=$?
T="$(tty 2>/dev/null)"
ash_lsof
ash_members
if [ -n "$MEMBERS" ]; then
  for e in $MEMBERS; do
    p="\${e%%:*}"; g="\${e##*:}"
    kill -s TERM -- "$p" 2>/dev/null
    [ "$g" -gt 1 ] 2>/dev/null && kill -s TERM -- "-$g" 2>/dev/null
  done
  sleep 0.2
  ash_members
  for e in $MEMBERS; do
    p="\${e%%:*}"; g="\${e##*:}"
    kill -s KILL -- "$p" 2>/dev/null
    [ "$g" -gt 1 ] 2>/dev/null && kill -s KILL -- "-$g" 2>/dev/null
  done
fi
exit $code`;

/**
 * 常用命令会话的 supervisor wrapper。与交互版的差别:命令退出后**不杀**余党 —— 组长退了
 * 后台还活着的 daemonize 形状是合法保活特性;但也**不弃养**:只要还有进程握着这个 tty,
 * wrapper(session leader)就活着轮询等待,于是会话在 manager 眼里保持「运行中」
 * (exitCode 未落),liveCommandSession 找得到、stop/restart/destroy 随时能经成员枚举
 * 确定性触达(第 5 轮审查:排除在 containment 外的命令会话,独立 PGID 服务会失控 +
 * 被重复启动)。服务全部退出后 wrapper 以命令原退出码退出,会话正常落「已结束」。
 */
export const TTY_COMMAND_WRAPPER = `${WRAPPER_PRELUDE}"$@"
code=$?
T="$(tty 2>/dev/null)"
ash_lsof
while :; do
  ash_members
  [ -z "$MEMBERS" ] && break
  sleep 2
done
exit $code`;

function parseHolderPids(stdout: string): number[] {
  // 排除 server 自己(持有全部 pty master,macOS lsof 把 master 也解析成 /dev/ttysN,
  // 见 WRAPPER_PRELUDE 注释)与非法 pid。
  return [...new Set(stdout.split("\n").map((line) => Number(line.trim()))
    .filter((pid) => pid > 1 && pid !== process.pid))];
}

/** Linux:扫 /proc/<pid>/fd 找「谁的某个 fd 指着这些 pty slave」。master 已关时链接目标带
 *  " (deleted)" 后缀,也算持有(进程还活着、fd 还开着)。 */
function procTtyHolders(ttyPaths: string[]): number[] {
  const targets = new Set(ttyPaths.flatMap((path) => [path, `${path} (deleted)`]));
  const holders: number[] = [];
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid <= 1 || pid === process.pid) continue;
      try {
        for (const fd of readdirSync(`/proc/${entry}/fd`)) {
          if (targets.has(readlinkSync(`/proc/${entry}/fd/${fd}`))) {
            holders.push(pid);
            break;
          }
        }
      } catch { /* 进程退出或无权限,跳过 */ }
    }
  } catch { /* /proc 读挂了,按空处理 */ }
  return holders;
}

/**
 * 「谁还握着这些 pty slave」:session leader 活着时的**确定性**会话成员清单(不依赖
 * ppid 树,disown 后照样在列)。Linux 走 /proc(零外部命令),其余 POSIX 用解析好的
 * lsof 绝对路径(不吃运行时 PATH)。返回 null = 无法枚举(机制缺失,或 leader 已退、
 * fd 已被 revoke、路径已回收)——调用方退回已知清单(快照 + 累积)判定,**不要**把
 * null 当「确证无人」。已消失的路径先过滤掉(lsof 分支):revoke 后本来就不可枚举,
 * 还会让 lsof 刷 usage 噪音。lsof 无匹配时退 1 但 stdout 可信:能解析出 pid 就用。
 */
export async function ttyHolderPids(ttyPaths: string[]): Promise<number[] | null> {
  if (IS_WINDOWS || !ttyPaths.length) return null;
  if (HAS_PROC) return procTtyHolders(ttyPaths);
  const paths = ttyPaths.filter((path) => existsSync(path));
  if (!paths.length || !LSOF_PATH) return null;
  try {
    const { stdout } = await execFileAsync(LSOF_PATH, ["-t", ...paths]);
    return parseHolderPids(stdout);
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (typeof stdout === "string" && stdout.trim()) return parseHolderPids(stdout);
    return null;
  }
}

/** ttyHolderPids 的同步版(close/shutdown 没有 await)。stderr 收进管道,别刷进服务日志。 */
export function ttyHolderPidsSync(ttyPaths: string[]): number[] | null {
  if (IS_WINDOWS || !ttyPaths.length) return null;
  if (HAS_PROC) return procTtyHolders(ttyPaths);
  const paths = ttyPaths.filter((path) => existsSync(path));
  if (!paths.length || !LSOF_PATH) return null;
  try {
    return parseHolderPids(execFileSync(LSOF_PATH, ["-t", ...paths], {
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
