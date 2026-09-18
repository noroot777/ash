// 终端会话清场要面对的硬事实:交互 shell 开着 job control(monitor mode)时,每个后台
// 作业(`cmd &`)会被 setpgid 进**独立进程组**(pgid == 作业领头进程 pid),`kill(-shellpgid)`
// 够不着它们。若作业忽略 HUP/TERM、shell 又先 exit,作业就被 PID 1 收养、ppid 树的线索
// 当场断掉 —— 只看 shell 原 pgid 的存活判断会把它当成「已清空」,实则还在跑、还占着端口
// (第 2 轮自由审查实锤)。
//
// 对策分三层(可靠性从高到低):
//   ① wrapper 常驻当 session leader:交互会话退出时确定性清杀、命令会话持续拥有(见下);
//   ② 结束/关服路径的实时快照:ppid 树 + 会话成员(leader 活着时确定性);
//   ③ 会话存续期**持续累积**见过的后代 pgid(①② 都不可用时的降级线索)。
// 这个文件只放纯函数与 wrapper 脚本(探活 + 读进程表 + 挖后代 + 枚举会话成员),
// 累积与信号逻辑在 terminal.ts。
//
// 「会话成员」怎么枚举(多轮探针的结论,别推翻重试已证伪的路):
//   - `ps -o sess=`:BSD 的会话指针,SIP 下对非 root 一律抹成 0,拿不到会话身份;
//   - `ps -o sid=`:macOS 的 ps 根本没有这个 keyword;`pgrep -s`:macOS 不支持;
//   - 但 `ps -o tty=`(kinfo 的 e_tdev,控制终端)**在 session leader 存活期间**一直指着
//     pty —— ctty 是会话属性而不是 fd,进程把 stdio 全部重定向掉(nohup 典型形状)也不
//     影响(第 6 轮探针实证:nohup 全重定向孤儿照样列出 ttysNNN);
//   - leader 一退,XNU revoke 整个会话的 tty fd + e_tdev 变 "??"(第 4 轮实测:孤儿 fd
//     表里连 tty 行都消失)—— 事后枚举无路。
// 结论:leader 必须常驻(TTY_REAPER_WRAPPER / TTY_COMMAND_WRAPPER 当 session leader,
// 真正的 shell/命令是它的孩子),枚举必须发生在 leader 活着的时候;成员判定 =
// **会话成员(Linux 读 /proc stat 的 session 字段;macOS 按 ps 的 ctty 列)∪ pty fd
// 持有者(lsof,补充覆盖「setsid 出逃但还握着 fd」的形状)**。只看 fd 持有者会漏掉
// stdio 全重定向的服务(第 6 轮审查实锤);只剩的真实残留:自己调 setsid() 且不留 fd
// 的**真 daemon**——那是刻意脱离终端的合法形状,与 Terminal.app/VSCode 行为一致。
import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { promisify } from "node:util";
import { IS_WINDOWS } from "./platform.js";

const execFileAsync = promisify(execFile);
const PS_ARGS = ["-axo", "pid=,ppid=,pgid="];
const PS_SESSION_ARGS = ["-axo", "pid=,pgid=,tty="];

/** Linux 的 procfs 可用:进程表 / 会话成员都能**零外部命令**从 /proc 读,精简容器免疫
 *  「lsof/ps 没装」(scripts/platform.mjs 记录过 Rocky 容器踩坑)。macOS 没有 /proc。 */
export const HAS_PROC = !IS_WINDOWS && existsSync("/proc/self/stat");

export type DescendantSnapshot = { pids: number[]; pgids: number[] };
export type ProcessTable = { children: Map<number, number[]>; pgidOf: Map<number, number> };
export type SessionMember = { pid: number; pgid: number };

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
  if (!PS_PATH) return null;
  try {
    const { stdout } = await execFileAsync(PS_PATH, PS_ARGS);
    return parseProcessTable(stdout);
  } catch {
    return null;
  }
}

/** readProcessTable 的同步版:退出钩子(shutdown)和 close() 里没有 await。 */
export function readProcessTableSync(): ProcessTable | null {
  if (IS_WINDOWS) return null;
  if (HAS_PROC) return procProcessTable();
  if (!PS_PATH) return null;
  try {
    return parseProcessTable(execFileSync(PS_PATH, PS_ARGS, { encoding: "utf8" }));
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
 * 关键外部命令的**绝对路径**解析:PATH 逐目录找,找不到再试知名安装位 —— `/usr/sbin`
 * 常常不在非交互 shell 的 PATH 里(scripts/platform.mjs 有同款教训)。解析结果经 env
 * (ASH_PS / ASH_LSOF)传给 wrapper、manager 侧枚举也用它,两边都不再依赖运行时 PATH
 * (第 5 轮审查:PATH 去掉 /usr/sbin 就静默失去清场能力)。
 */
function resolveBinPath(name: string, pathEnv: string | undefined, fallbacks: string[]): string | null {
  if (IS_WINDOWS) return null;
  for (const dir of (pathEnv ?? "").split(":")) {
    if (!dir) continue;
    const candidate = `${dir}/${name}`;
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* 下一个 */ }
  }
  for (const candidate of fallbacks) {
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* 下一个 */ }
  }
  return null;
}

export function resolveLsofPath(
  pathEnv: string | undefined = process.env.PATH,
  fallbacks: string[] = ["/usr/sbin/lsof", "/usr/bin/lsof", "/opt/homebrew/bin/lsof"],
): string | null {
  return resolveBinPath("lsof", pathEnv, fallbacks);
}

/** macOS 的 ps 固定在 /bin/ps(系统卷,SIP 保护);Linux 常见 /bin 或 /usr/bin。 */
export function resolvePsPath(
  pathEnv: string | undefined = process.env.PATH,
  fallbacks: string[] = ["/bin/ps", "/usr/bin/ps"],
): string | null {
  return resolveBinPath("ps", pathEnv, fallbacks);
}

export const LSOF_PATH = resolveLsofPath();
export const PS_PATH = resolvePsPath();

/**
 * 终端 containment 依赖是否齐备:Linux 靠 /proc(零外部命令),其余 POSIX 靠 ps 的
 * ctty 枚举(lsof 只是补充,不再是硬依赖)。都没有就**不能承诺**「关会话时清空进程树」
 * —— 终端 create 会显式拒绝(terminal.ts),绝不静默降级到已被证伪的采样后继续对清场
 * 报成功(第 5 轮审查)。
 */
export function containmentAvailable(): boolean {
  return !IS_WINDOWS && (HAS_PROC || PS_PATH !== null);
}

// ── wrapper 脚本 ────────────────────────────────────────────────────────────────
// 共享 prelude。ash_members 产出 " pid:pgid" 清单,成员判定 = 会话成员 ∪ pty fd 持有者
// (为什么是这两条、为什么必须在 leader 存活期间枚举,见文件头)。两个硬性排除,少一个
// 都出事故:`$$`(wrapper 自己,不排除就自杀)与 `$ASH_PTY_PARENT`(ash server:macOS
// 的 lsof 把 pty **master** 端也解析成同一个 /dev/ttysN,不排除会把 server TERM 掉,
// probe4 实测 exit 143)。
// 枚举工具自身的防呆(各卡死过一次 KEEPER 等待循环):
//   - macOS 的 ps 走「后台起 ps 写临时文件、记下 $!、父 shell read 过滤」—— ps 自己也是
//     会话成员、会出现在自己的快照里,靠 $PSPID 精确排除;不经命令替换,子 shell 不进场。
//   - lsof 补充枚举经命令替换,中间 subshell 在 lsof 扫描期间握着 tty:子 shell 先 exec
//     重定向自身;pgid 查不到(ps 输出为空 = 已死的瞬时进程)的命中一律跳过。
//   - Linux 分支用 read 内建读 stat,零 fork;fd 反查的 ls/grep 是瞬时子进程,不在循环
//     开头展开的 /proc 通配結果里,不会自计。
const WRAPPER_PRELUDE = `ash_bins() {
  PSB="$ASH_PS"
  [ -x "$PSB" ] || PSB="$(command -v ps 2>/dev/null)"
  [ -x "$PSB" ] || PSB=/bin/ps
  [ -x "$PSB" ] || PSB=""
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
      { read -r s < "$d/stat"; } 2>/dev/null || continue
      r="\${s##*) }"
      set -- $r
      if [ "$4" = "$$" ]; then
        MEMBERS="$MEMBERS $p:$3"
      elif [ -n "$T" ] && ls -l "$d/fd" 2>/dev/null | grep -q -- "-> $T\\$"; then
        MEMBERS="$MEMBERS $p:$3"
      fi
    done
    return 0
  fi
  TN="\${T#/dev/}"
  if [ -n "$TN" ] && [ -n "$PSB" ]; then
    TF="\${TMPDIR:-/tmp}/.ash_members.$$"
    "$PSB" -axo pid=,pgid=,tty= </dev/null > "$TF" 2>/dev/null &
    PSPID=$!
    wait "$PSPID"
    while read -r p g t; do
      [ "$t" = "$TN" ] || continue
      [ "$p" = "$$" ] && continue
      [ "$p" = "$PSPID" ] && continue
      [ -n "$ASH_PTY_PARENT" ] && [ "$p" = "$ASH_PTY_PARENT" ] && continue
      MEMBERS="$MEMBERS $p:$g"
    done < "$TF"
    rm -f "$TF"
  fi
  if [ -n "$T" ] && [ -n "$L" ]; then
    for p in $(exec </dev/null 2>/dev/null; "$L" -t "$T"); do
      [ "$p" = "$$" ] && continue
      [ -n "$ASH_PTY_PARENT" ] && [ "$p" = "$ASH_PTY_PARENT" ] && continue
      case "$MEMBERS" in *" $p:"*) continue ;; esac
      g="$("\${PSB:-ps}" -o pgid= -p "$p" 2>/dev/null | tr -d ' ')"
      [ -n "$g" ] || continue
      MEMBERS="$MEMBERS $p:$g"
    done
  fi
}
`;

/**
 * 交互会话的 containment wrapper。作为 pty 的直接子进程(= session leader)常驻,内层
 * 用户 shell 经 "$@" 起($0 占位、$1.. 是 shell 与参数)。内层 shell 退出(任意方式,含
 * kill -9)后 leader 仍活、revoke 未发生,此刻的成员枚举是**确定性**的 —— 对余党
 * TERM→0.2s→重枚举→KILL(逐 pid + 逐进程组,防独立组/重定向了 stdio 的成员漏杀),
 * 然后以内层退出码退出。不依赖任何采样命中(第 4 轮);枚举机制不可用时 manager 的
 * create 已拒绝开会话,不会走到这里。
 */
export const TTY_REAPER_WRAPPER = `${WRAPPER_PRELUDE}"$@"
code=$?
T="$(tty 2>/dev/null)"
ash_bins
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
 * 后台还活着的 daemonize 形状是合法保活特性;但也**不弃养**:只要会话里还有成员(含
 * stdio 全重定向、独立 PGID 的 nohup 形状,第 6 轮审查实锤),wrapper(session leader)
 * 就活着轮询等待,于是会话在 manager 眼里保持「运行中」(exitCode 未落),
 * liveCommandSession 找得到、stop/restart/destroy 随时能经成员枚举确定性触达(第 5 轮
 * 审查)。服务全部退出后 wrapper 以命令原退出码退出,会话正常落「已结束」。
 */
export const TTY_COMMAND_WRAPPER = `${WRAPPER_PRELUDE}"$@"
code=$?
T="$(tty 2>/dev/null)"
ash_bins
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

/** Linux:一次 /proc 扫描拿会话成员(stat 的 session 字段 ∈ leaders)∪ pty fd 持有者
 *  (master 已关时链接目标带 " (deleted)" 后缀,也算持有)。 */
function procSessionMembers(leaderPids: number[], ttyPaths: string[]): SessionMember[] {
  const leaders = new Set(leaderPids);
  const targets = new Set(ttyPaths.flatMap((path) => [path, `${path} (deleted)`]));
  const members: SessionMember[] = [];
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid <= 1 || pid === process.pid) continue;
      try {
        const fields = procStatFields(readFileSync(`/proc/${entry}/stat`, "utf8"));
        const pgid = Number(fields[2]);
        const sid = Number(fields[3]);
        if (leaders.has(sid)) { members.push({ pid, pgid }); continue; }
        if (!targets.size) continue;
        for (const fd of readdirSync(`/proc/${entry}/fd`)) {
          if (targets.has(readlinkSync(`/proc/${entry}/fd/${fd}`))) {
            members.push({ pid, pgid });
            break;
          }
        }
      } catch { /* 进程退出或无权限,跳过 */ }
    }
  } catch { /* /proc 读挂了,按空处理 */ }
  return members;
}

/** ps 的 ctty 快照(pid pgid tty)+ lsof 的 fd 持有者,合成去重后的成员清单。 */
function membersFromPs(stdout: string, ttyNames: Set<string>, lsofPids: number[]): SessionMember[] {
  const members = new Map<number, number>();
  const pgidOf = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const pgid = Number(parts[1]);
    if (!pid || Number.isNaN(pgid)) continue;
    pgidOf.set(pid, pgid);
    if (ttyNames.has(parts[2])) members.set(pid, pgid);
  }
  for (const pid of lsofPids) {
    if (!members.has(pid)) members.set(pid, pgidOf.get(pid) ?? 0);
  }
  return [...members.entries()]
    .filter(([pid]) => pid > 1 && pid !== process.pid)
    .map(([pid, pgid]) => ({ pid, pgid }));
}

function existingTtyPaths(ttyPaths: string[]): string[] {
  // lsof 对已消失的路径刷 usage 噪音,先过滤;返回仍存在的路径。
  return ttyPaths.filter((path) => existsSync(path));
}

/**
 * 「这些 pty 会话里还有谁」:session leader(wrapper)活着时的**确定性**成员清单 ——
 * 不依赖 ppid 树,disown、独立 PGID、stdio 全重定向都照样在列。Linux 走 /proc(零外部
 * 命令),其余 POSIX 用解析好的 ps 绝对路径按 ctty 枚举,lsof(若有)补充 fd 持有者。
 * 返回 null = 无法枚举(机制缺失)——调用方退回已知清单(快照 + 累积)判定,**不要**
 * 把 null 当「确证无人」。leader 已退、ctty 已被 revoke 的会话,本来就不可枚举,
 * 返回的是空命中而不是 null。
 */
export async function sessionMemberPids(leaderPids: number[], ttyPaths: string[]): Promise<SessionMember[] | null> {
  if (IS_WINDOWS || (!leaderPids.length && !ttyPaths.length)) return null;
  if (HAS_PROC) return procSessionMembers(leaderPids, ttyPaths);
  if (!PS_PATH) return null;
  const ttyNames = new Set(ttyPaths.map((path) => path.replace(/^\/dev\//, "")));
  try {
    const { stdout } = await execFileAsync(PS_PATH, PS_SESSION_ARGS);
    let lsofPids: number[] = [];
    const paths = existingTtyPaths(ttyPaths);
    if (paths.length && LSOF_PATH) {
      try {
        lsofPids = parseHolderPids((await execFileAsync(LSOF_PATH, ["-t", ...paths])).stdout);
      } catch (error) {
        const out = (error as { stdout?: string }).stdout;
        if (typeof out === "string" && out.trim()) lsofPids = parseHolderPids(out);
      }
    }
    return membersFromPs(stdout, ttyNames, lsofPids);
  } catch {
    return null;
  }
}

/** sessionMemberPids 的同步版(close/shutdown 没有 await)。stderr 收进管道,别刷日志。 */
export function sessionMemberPidsSync(leaderPids: number[], ttyPaths: string[]): SessionMember[] | null {
  if (IS_WINDOWS || (!leaderPids.length && !ttyPaths.length)) return null;
  if (HAS_PROC) return procSessionMembers(leaderPids, ttyPaths);
  if (!PS_PATH) return null;
  const ttyNames = new Set(ttyPaths.map((path) => path.replace(/^\/dev\//, "")));
  try {
    const stdout = execFileSync(PS_PATH, PS_SESSION_ARGS, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    let lsofPids: number[] = [];
    const paths = existingTtyPaths(ttyPaths);
    if (paths.length && LSOF_PATH) {
      try {
        lsofPids = parseHolderPids(execFileSync(LSOF_PATH, ["-t", ...paths], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }));
      } catch (error) {
        const out = (error as { stdout?: string | Buffer }).stdout;
        const text = typeof out === "string" ? out : out?.toString() ?? "";
        if (text.trim()) lsofPids = parseHolderPids(text);
      }
    }
    return membersFromPs(stdout, ttyNames, lsofPids);
  } catch {
    return null;
  }
}
