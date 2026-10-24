// 平台差异的**单点**。凡是「这条在 Windows 上得换个命令」的系统调用都从这里出，
// 不要在业务文件里各写一份 `process.platform === "win32"` 分支 —— 那样每加一处
// 就多一个会漂移的口径,而 Windows 上没人跑测试,漂了也不会有人发现。
//
// 三条系统能力在这里被抽象:
//  ① 进程表(pid / ppid / 启动时间 / 命令行)—— macOS/Linux 走 `ps`,Windows 走 PowerShell
//     的 `Get-CimInstance Win32_Process`(降级 `Get-WmiObject`)
//  ② 进程树击杀 —— POSIX 走进程组信号,Windows 走 `taskkill /T /F`
//  ③ 端口占用者 —— `lsof` vs `Get-NetTCPConnection`(降级 `netstat -ano`)
//
// **如实记录的能力缺口(Windows)**:
//  · `taskkill /T` 靠 ppid 关系遍历,杀不到「中间层已死」的深孤儿。Windows 没有
//    reparent,孤儿的 ParentProcessId 字段保留原值,但 pid 复用会污染它 —— 没有零
//    依赖的等价物。killEscapees 因此在 Windows 上是**尽力而为**,不是保证。
//  · 「谁打开着这个文件」(lsof -t <file>)在 Windows 上没有零依赖等价物(handle.exe
//    要单独装且要管理员)。依赖它的两处(单实例锁的兜底扫描、逃逸追踪 fd)一律降级,
//    并在各自调用点写明降级后剩什么。

import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { IS_WINDOWS } from "./platform-os.js";
import { join } from "node:path";

// 「这是哪个操作系统」住在 platform-os.ts(叶子模块,打断本文件与 platform-paths.ts
// 的环,理由见那边顶部)。这个门原样转出,使用方照旧从 platform.js 取。
export { IS_MAC, IS_WINDOWS } from "./platform-os.js";

// ── `~` 展开 ───────────────────────────────────────────────────────────────
// Users type `~/code/foo`, but Node's fs/git APIs don't understand `~` (only
// shells do) — so expand a leading `~` to the home dir before any filesystem
// use. Applied at every repoPath boundary (projects.repo_path 存的就是带 `~` 的
// 原样文本,见 git.ts tidyRepoPath),所以 `~` 能在全系统生效。
// Windows 上用户会写成 `~\code\foo`,反斜杠是那边的正规分隔符,一并认。
//
// 住在 platform.ts 而不是 git.ts:它跟 git 无关(是路径/平台的事),而 `/` 补全的
// 技能扫描是同步热路径,不该为一个纯函数把整条 git 链(exec / repo-lock /
// git-worktree-state)拖进来。`git.ts` 仍原样转出,存量导入点不用动。
export function expandHome(p: string | null | undefined): string {
  if (!p) return "";
  if (p === "~") return homedir();
  if (p.startsWith("~/") || (IS_WINDOWS && p.startsWith("~\\"))) return join(homedir(), p.slice(2));
  return p;
}

// ── PowerShell 调用 ────────────────────────────────────────────────────────
// 脚本一律走 -EncodedCommand(UTF-16LE + base64):PowerShell 的引号规则跟 cmd 的
// 引号规则叠在一起是个雷区,编码传参把整片雷区绕开 —— 脚本里可以随便用引号、
// 反引号、`$`,不需要任何转义。

let cachedShell: string | null | undefined;

/** 本机可用的 PowerShell:优先 PowerShell 7(pwsh),回退 Windows PowerShell 5.1。 */
function powerShellExe(): string | null {
  if (cachedShell !== undefined) return cachedShell;
  cachedShell = null;
  for (const candidate of ["pwsh.exe", "powershell.exe"]) {
    try {
      execFileSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
        stdio: "ignore",
        timeout: 10_000,
        windowsHide: true,
      });
      cachedShell = candidate;
      break;
    } catch {
      /* 试下一个 */
    }
  }
  return cachedShell;
}

/**
 * `-EncodedCommand` 的载荷。导出是因为不止这个文件要跑 PowerShell —— dir-picker.ts 得自己
 * 挑 exe（GUI 对话框要 STA，候选顺序跟这里相反），但编码规则只该有一份。
 */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * POSIX 沿用登录 sh；Windows 普通命令沿用 cmd，保留 npm/批处理/&& 的兼容性。
 * ps1 入口显式交给 PowerShell，避免 cmd 通过文件关联弹出「选择打开方式」。
 * PowerShell 路径复用本机探测，命令编码后传入，带空格的脚本路径通过 & 调用。
 */
export function userShellLaunch(command: string): {
  file: string;
  args: string[];
  windowsVerbatimArguments?: true;
} {
  if (!IS_WINDOWS) return { file: "sh", args: ["-lc", command] };
  const isPowerShellScript = /^\s*(?:&\s*)?(?:"[^"\r\n]+\.ps1"|'[^'\r\n]+\.ps1'|[^\s"'|&;<>]+\.ps1)(?=\s|$|[|&;<>])/i.test(command);
  if (isPowerShellScript) {
    const invocation = /^\s*&/.test(command) ? command : `& ${command.trimStart()}`;
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "$OutputEncoding = [Console]::OutputEncoding",
      invocation,
      "$__ashSucceeded = $?",
      "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }",
      "if (-not $__ashSucceeded) { exit 1 }",
      "exit 0",
    ].join("\n");
    return {
      file: powerShellExe() ?? "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text", "-EncodedCommand", encodePowerShellCommand(script)],
    };
  }
  return {
    file: process.env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", `"${command}"`],
    windowsVerbatimArguments: true,
  };
}

const encodeCommand = encodePowerShellCommand;

/** 同步跑一段 PowerShell,拿 stdout。失败(含 PowerShell 不可用)一律空串。 */
export function powerShellSync(script: string, timeoutMs = 10_000): string {
  const exe = powerShellExe();
  if (!exe) return "";
  try {
    return execFileSync(exe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeCommand(script)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      maxBuffer: 16 << 20,
      windowsHide: true,
    });
  } catch {
    return "";
  }
}

/** 异步版本。同样「失败即空串」——系统探测拿不到不该拖垮调用方。 */
export const powerShell = async (script: string, timeoutMs = 10_000): Promise<string> =>
  (await runPowerShell(script, timeoutMs)) ?? "";

/**
 * 同上,但**分得出「它跑完了」和「它出错了」**(`null` = 没答出来)。
 *
 * 需要这一支是因为「出错 + 吐了半截」和「跑完了、就这些」在 `powerShell` 那一支里长得一模
 * 一样,而两者的后果相反:诊断用途拿半截也比没有好,而**进程表**那一路的缺席会被读成「这个
 * 进程不在树上」—— 半截表于是等于把没扫到的后代宣布成不存在(第 5 轮审查 F1 的同一个类)。
 */
function runPowerShell(script: string, timeoutMs: number): Promise<string | null> {
  const exe = powerShellExe();
  if (!exe) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      exe,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeCommand(script)],
      { timeout: timeoutMs, maxBuffer: 16 << 20, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout || ""),
    );
  });
}

// ── 进程表 ────────────────────────────────────────────────────────────────

export type ProcessRow = {
  pid: number;
  /**
   * 父进程号。**`null` = 这一行说不出它挂在谁下面**(第 7 轮审查 F1)。
   *
   * 上一版把拿不到的父号规范化成 0,于是「问不出来」长得跟「它没有父进程」一模一样 ——
   * 而建树那一侧靠这条边决定它在不在我们的子树里,缺边读作「不是我们的后代」。两者的处置
   * 相反:真的没有父进程(内核那一层)可以安心跳过,问不出来则必须让这一轮答「没问清楚」。
   */
  ppid: number | null;
  /** ISO 8601(Windows)或 ps 的 lstart 原文(POSIX)。拿不到为 null。 */
  startedAt: string | null;
  command: string;
};

// Win32_Process 的 CreationDate 在 CIM 下已是 DateTime,在旧 WMI 下是 DMTF 字符串
// (20260814123045.123456+480),两种都归一成 ISO;命令行里的换行/制表一律压成空格,
// 否则会把「一行一个进程」的约定撕开。
//
// 两条容易踩空的:
//  · 输出一律走 [Console]::Out.WriteLine —— 直接把字符串丢进管道的话,Windows
//    PowerShell 5.1 的格式化器会按控制台宽度**硬折行**,而 agent 的命令行动辄
//    两三百字符,折了就再也拼不回去(症状是 ppid 那一列突然变成路径片段)。
//  · OutputEncoding 钉成 UTF-8 —— 默认是 OEM 代码页,中文路径过来就是乱码。
const PS_PROCESS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function ConvStart($v) {
  if ($null -eq $v) { return '' }
  if ($v -is [datetime]) { return $v.ToUniversalTime().ToString('o') }
  try { return [Management.ManagementDateTimeConverter]::ToDateTime([string]$v).ToUniversalTime().ToString('o') } catch { return '' }
}
$procs = $null
try { $procs = Get-CimInstance Win32_Process -ErrorAction Stop } catch { $procs = Get-WmiObject Win32_Process }
foreach ($p in $procs) {
  $cmd = [string]$p.CommandLine
  if (-not $cmd) { $cmd = [string]$p.Name }
  $cmd = $cmd -replace '[\\r\\n\\t]', ' '
  [Console]::Out.WriteLine("$($p.ProcessId)\`t$($p.ParentProcessId)\`t$(ConvStart $p.CreationDate)\`t$cmd")
}
`;

/**
 * Windows 那张表,**认下来的行 + 没认出号的行数**(见 `ProcessTableRead`)。
 *
 * 导出只为了钉回归(`test:process-subtrees`):这段判据的输入形状只在 Windows 上出现,
 * 而它判错的代价是在那台机器上压一笔永远销不掉的债 —— 纯函数能在任何平台上被钉住。
 *
 * 「没认出来」只算真的认不出的那种:行首像个号、却凑不出字段或号不是整数。0 号(System
 * Idle Process)每次都在这张表里,它永远不可能是我们的进程 —— 实测把它算成「丢了一行」,
 * 于是 Windows 上每一次清理都凭一条假线索压一笔永远销不掉的债(真机实测:行数 298、
 * 「没认出来」1,就是它)。
 */
export function readWindowsRows(text: string): ProcessTableRead {
  const rows: ProcessRow[] = [];
  let unnamed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const pid = Number(parts[0]);
    if (parts.length < 4 || !Number.isInteger(pid)) {
      if (/^\s*\d/.test(line)) unnamed += 1;    // 行首像个号、整行却认不出来 ⇒ 这一行等于没进表
      continue;
    }
    if (pid <= 0) continue;                     // 0 号:认得出来、不是进程,跳过不算丢
    // 父号这一列拿不到就如实给 `null`(`ParentProcessId` 读不到时这一列是空串)。规范化成 0
    // 等于把「问不出来」说成「它没有父进程」,而 Windows 上根退出之后,保留下来的父号正是
    // 找到后代的唯一线索(第 7 轮审查 F1)。
    const ppid = Number(parts[1]);
    rows.push({
      pid,
      ppid: parts[1]!.trim() && Number.isInteger(ppid) && ppid >= 0 ? ppid : null,
      startedAt: parts[2]!.trim() || null,
      command: parts.slice(3).join("\t").trim(),
    });
  }
  return { rows, unnamed };
}

const POSIX_PS_ARGS = ["-ww", "-axo", "pid=,ppid=,command="];

/** POSIX 那张表,同样带上「行首像个号、却没认出来」的行数(判据与 `readWindowsRows` 同源)。 */
function readPosixRows(text: string): ProcessTableRead {
  const rows: ProcessRow[] = [];
  let unnamed = 0;
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) {
      if (/^\s*\d/.test(line)) unnamed += 1;
      continue;
    }
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), startedAt: null, command: m[3]! });
  }
  return { rows, unnamed };
}

/**
 * 全表快照(pid / ppid / 命令行)。**startedAt 只有 Windows 那支填得上** —— POSIX 这支
 * 为了跟历史口径一致仍用 `ps -axo pid=,ppid=,command=`,要启动时间请单独调
 * `inspectProcess`(它按单个 pid 问,带 lstart)。
 *
 * **这一支是尽力而为的那一档**:查不到、或者只拿到半截,一律按拿到的那些返回 —— 它的三个
 * 调用方(预览诊断、MCP 持有者、删目录失败后的取证)都只拿它**加**信息,缺席在那边从来不
 * 当证明用。要拿它证明「某个进程不在」的,用 `listProcessesComplete`。
 */
export async function listProcesses(timeoutMs = 3000): Promise<ProcessRow[]> {
  return (await listProcessesComplete(timeoutMs))?.rows ?? [];
}

/**
 * 一次进程表读数:**认下来的行,外加「有几行连号都认不出来」**。
 *
 * 为什么要带后面那个数(第 6 轮审查 F1):认不出号的行被静默丢掉之后,它在表里就等于不存在,
 * 而进程树那一路靠「缺席」下结论。它跟 `startedAt: null` 那一档不同 —— 那一档还知道是哪个号
 * (能记成「在表上、核验不了这一代」),这一档连名字都没有,只能如实说「这张表里有几行没认出来」。
 */
export type ProcessTableRead = { rows: ProcessRow[]; unnamed: number };

/**
 * 同上,但**问全了才给表**(`null` = 这一问没答出来)。
 *
 * 进程表那一路靠「缺席」下结论:一个号不在表里就等于「它不在这棵树上」。所以半截表在那边
 * 不是「少点信息」而是**错的答案** —— 它把没扫到的后代宣布成不存在,而那正是清理要找的人
 * (第 5 轮审查 F1 在 POSIX 那一支上实测:`ps` 退 2 + 一行输出照样被解析成了一棵进程树)。
 *
 * 判据跟 `track-evidence.ts` 的 `heldNames` 同源:**宁可整问重来**,下一轮再问。
 */
export async function listProcessesComplete(timeoutMs = 3000): Promise<ProcessTableRead | null> {
  if (IS_WINDOWS) {
    const out = await runPowerShell(PS_PROCESS_SCRIPT, timeoutMs);
    return out === null ? null : readWindowsRows(out);
  }
  const text = await new Promise<string | null>((resolve) => {
    execFile("ps", POSIX_PS_ARGS, { timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout) =>
      resolve(err ? null : stdout || ""),
    );
  });
  return text === null ? null : readPosixRows(text);
}


/**
 * 命令行里明确引用了某个路径的进程。用于删除目录失败后的诊断,不是权限判据:
 * cwd 本身不一定出现在 argv,所以空数组只表示「没认出来」,绝不表示无人占用。
 */
export async function findProcessesReferencingPath(path: string, timeoutMs = 3000): Promise<ProcessRow[]> {
  const windows = path.replace(/\//g, "\\").toLowerCase();
  const posix = path.replace(/\\/g, "/").toLowerCase();
  return (await listProcesses(timeoutMs)).filter((row) => {
    if (row.pid === process.pid) return false;
    const command = row.command.toLowerCase();
    return command.includes(windows) || command.includes(posix);
  });
}

/** 单个进程的启动时间 + 命令行。查不到返回 null(调用方一律按「不存在」处理)。 */
export function inspectProcessSync(pid: number): { startedAt: string | null; command: string | null } | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (IS_WINDOWS) {
    // PowerShell 冷启动是百毫秒量级。这条只在「拿锁 / 重启接管」这类低频路径上跑,
    // 不在热路径 —— 真挪到热路径前先测一次。要问一批号用 `inspectProcessesSync`。
    return inspectProcessesSync([pid]).get(pid) ?? null;
  }
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command=", "-ww"], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    const m = /^(.{24})\s+(.*)$/.exec(out);
    return { startedAt: m ? m[1]!.trim() : null, command: m ? m[2]!.trim() : out };
  } catch {
    return null;
  }
}

// ── 进程树击杀 ─────────────────────────────────────────────────────────────

/**
 * 杀掉一棵进程树。
 *
 * POSIX:进程组信号(spawn 时 detached 让 agent 自成组长),失败退回单进程。
 * Windows:`taskkill /PID <pid> /T /F`。参数走 execFile 数组,天然免疫命令注入
 * (`tree-kill` 1.2.2 修过的正是把 pid 拼进字符串的那类洞)。sig 在 Windows 上只
 * 区分「杀不杀」——`/F` 已是强杀,没有优雅一档。
 *
 * 同步返回:调用方历史上就是「发完就走」,不等确认。
 */
export function killTree(pid: number, sig: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  if (IS_WINDOWS) {
    // 退出码非 0 = 进程已经不在了,不是错误。
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  }
}

/** 单个进程击杀(不含后代)。Windows 上没有信号,一律 taskkill /F。 */
export function killOne(pid: number, sig: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  if (IS_WINDOWS) {
    execFile("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(pid, sig);
  } catch {
    /* already gone */
  }
}

// 这一摊里**两件事搬走了**,因为它们各自是一个独立的概念,不是「怎么问操作系统」的单问:
//  · 「资源单位」那条记号(`ASH_MONITOR_UNIT`)的扫描 → monitor-unit-scan.ts(要读整张进程表、
//    分证据等级、还带一份备忘);
//  · **代次**(「这个号上还是不是那一代」)和按代次枚举组成员 → process-generation.ts
//    (事实与它那一代必须同源,见那个文件的头注)。

export function isProcessGroupAlive(pid: number): boolean {
  if (IS_WINDOWS || !Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/**
 * 这个 pid 还活着吗。
 * `process.kill(pid, 0)` 在 Windows 上是 libuv 明确支持的存活探测(uv__kill 对
 * signum 0 直接 return 0,不会 TerminateProcess),所以两个平台同一条实现;
 * EPERM = 进程在、只是没权限看。
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/**
 * 这些号上**还有进程在跑**吗 —— 僵尸不算,返回的是「在跑」的那些。
 *
 * 跟 `isPidAlive` 的区别只有僵尸这一档,而那一档恰恰是清理判据要分开的:`kill(pid,0)`
 * 问的是「这个号还占着吗」,僵尸占着号 —— 它已经 `exit` 过了,只等父进程 `wait` 掉它。
 * 「还欠谁」问的却是「还有谁在跑、在写」,一个退出过的进程一行都不会再写、也收不到信号。
 *
 * **这是把判据磨利,不是放松**:僵尸是「已经退出」的一种**正面证据**,比「号上没人了」
 * 更强(号上没人还有被复用的可能,僵尸连 exec 都做不到了)。放松是「证不出来就当没有」,
 * 这里是「证出来它退了」。问不出来的一律按「还占着」算,不冒充证据。
 *
 * 真实现场(容器里实测,2026-10-22):PID 1 不是 init 而是 `sleep infinity` 时**没人
 * 收割**,被整圈杀掉的后代就永远停在 `Z` 上 —— 那一刻圈是空的、清理也确实干净了,可
 * 账本上那个号按 `isPidAlive` 永远核销不掉,于是每一轮清扫都重押同一笔债。
 *
 * **成批问是因为这一问在热路径上**:收尾那两秒每 50 ms 要问一遍整份名单,而 macOS 上
 * 它要起一个 `ps`。逐个问的代价随名单长度线性涨(第 2 轮审查「每 pid 每 50 ms 一次同步
 * ps」),批成一次之后与名单多长无关;Linux 读 `/proc` 本来就不起进程。
 */
export function runningPids(pids: readonly number[]): Set<number> {
  const running = new Set<number>();
  const occupied = [...new Set(pids)].filter((pid) => isPidAlive(pid));
  if (!occupied.length) return running;
  // Windows 没有僵尸这一档:进程退出即从进程表消失,「号还占着」就等于「还在跑」。
  if (IS_WINDOWS) {
    for (const pid of occupied) running.add(pid);
    return running;
  }
  const askPs: number[] = [];
  for (const pid of occupied) {
    const zombie = zombieViaProcStat(pid);
    if (zombie === null) askPs.push(pid);           // 没有 /proc(macOS)或这一刻读不了
    else if (!zombie) running.add(pid);
  }
  if (!askPs.length) return running;
  const states = psStates(askPs);
  for (const pid of askPs) {
    const state = states?.get(pid);
    if (state !== undefined) {
      if (!state.startsWith("Z")) running.add(pid);  // 僵尸在这份输出里是 `Z`,正是要分开的那一档
      continue;
    }
    // 这份输出里没有它:要么它真的退了,要么这一问被整个拒了(名单里混进越界的号时
    // macOS 的 `ps` 会一行都不给)。**不拿一次失败冒充退出证据** —— 用便宜那一问再确认
    // 一次,号还占着就按「在跑」算。僵尸走不到这条分支(它在输出里,状态是 `Z`)。
    if (isPidAlive(pid)) running.add(pid);
  }
  return running;
}

/** 单个号的那一问。判据与理由见 `runningPids`。 */
export const isPidRunning = (pid: number): boolean => runningPids([pid]).has(pid);

/**
 * **一次读数问一批号**的启动时刻与命令行。查不到的号不在结果里。
 *
 * Windows 上这一问要起 PowerShell(百毫秒量级),所以逐个问的代价随名单长度线性涨 ——
 * 内核圈定的成员集合正是「一批号一起问」的形状(confine-job.ts 的 `parseMembers`:上一版
 * 逐个问,于是给前 8 个成员取代次就要 8 次冷启动,第 1 轮审查 F4;改成一次问完之后,代次
 * 对**所有**成员都拿得到,而成本是一次)。
 *
 * 过滤串不能无限长,所以名单超过 `FILTER_MAX` 就不过滤、整张表拉回来自己挑 —— 整表那一问
 * 跟过滤那一问是同一次冷启动,只是多传些行回来。
 */
export function inspectProcessesSync(
  pids: readonly number[],
): Map<number, { startedAt: string | null; command: string | null }> {
  const found = new Map<number, { startedAt: string | null; command: string | null }>();
  const want = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (!want.length) return found;
  const FILTER_MAX = 32;
  if (IS_WINDOWS) {
    const filter = want.length <= FILTER_MAX
      ? want.map((pid) => `ProcessId=${pid}`).join(" or ")
      : null;
    const script = filter
      ? PS_PROCESS_SCRIPT
        .replace("Get-CimInstance Win32_Process -ErrorAction Stop", `Get-CimInstance Win32_Process -Filter "${filter}" -ErrorAction Stop`)
        .replace("Get-WmiObject Win32_Process", `Get-WmiObject Win32_Process -Filter "${filter}"`)
      : PS_PROCESS_SCRIPT;
    const wanted = new Set(want);
    for (const row of readWindowsRows(powerShellSync(script)).rows) {
      if (wanted.has(row.pid)) found.set(row.pid, { startedAt: row.startedAt, command: row.command || null });
    }
    return found;
  }
  // POSIX:`ps` 一次收下整份名单。字段顺序与单号那一问一致(`lstart` 定宽 24 列在前)。
  let out: string;
  try {
    out = execFileSync("ps", ["-p", want.join(","), "-o", "pid=,lstart=,command=", "-ww"], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    out = String((error as { stdout?: unknown })?.stdout ?? "");
  }
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.{24})\s+(.*)$/.exec(line);
    if (!m) continue;
    found.set(Number(m[1]), { startedAt: m[2]!.trim(), command: m[3]!.trim() || null });
  }
  return found;
}

/** `/proc/<pid>/stat` 的状态位。`null` = 这台机器没有 /proc,或者这一刻读不了。 */
function zombieViaProcStat(pid: number): boolean | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  // 第 3 个字段是状态,但命令名里可以有空格和右括号 —— 按**最后**一个 `)` 切。
  return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0] === "Z";
}

/** 一次 `ps` 问完这一批号的状态位。`null` = 这一问整个失败了。 */
function psStates(pids: readonly number[]): Map<number, string> | null {
  let out: string;
  try {
    out = execFileSync("ps", ["-o", "pid=,state=", "-p", pids.join(",")], {
      encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    // 名单里的号全退了时 `ps` 以非 0 退出、且没有输出 —— 那是**答出来了**(都没了),
    // 不是失败。有输出就按输出算:剩下的那几行就是还在的。
    const text = String((error as { stdout?: unknown })?.stdout ?? "");
    if (!text.trim()) return new Map();
    out = text;
  }
  const states = new Map<number, string>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\S+)/.exec(line);
    if (m) states.set(Number(m[1]), m[2]!);
  }
  return states;
}

// ── 端口占用者 ─────────────────────────────────────────────────────────────

/** 谁在监听这个端口。查不到(命令不可用 / 竞态)返回空数组。 */
export function listenerPidsSync(port: number): number[] {
  if (IS_WINDOWS) {
    const out = powerShellSync(
      `$ErrorActionPreference='SilentlyContinue'
try { (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop).OwningProcess }
catch { netstat -ano | Select-String ':${port}\\s' | Select-String 'LISTENING' | ForEach-Object { ($_ -split '\\s+')[-1] } }`,
    );
    return uniquePids(out.split(/\s+/));
  }
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return uniquePids(out.split(/\s+/));
  } catch {
    return [];
  }
}

/** 「怎么查这个端口」的可复制命令,直接印给用户。 */
export function inspectPortCommand(port: number): string {
  return IS_WINDOWS
    ? `Get-NetTCPConnection -LocalPort ${port} -State Listen`
    : `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
}

/** 「怎么停掉这些进程」的可复制命令。 */
export function killPidsCommand(pids: number[]): string {
  return IS_WINDOWS
    ? `taskkill /PID ${pids.join(" /PID ")} /T /F`
    : `kill ${pids.join(" ")}`;
}

function uniquePids(tokens: string[]): number[] {
  return [...new Set(tokens.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

// ── 纯路径/字符串那一半:住在 platform-paths.ts,从这里原样转出 ──────────────
// 这个文件是「平台差异的单点」那个门,拆分不改变门的位置(见 platform-paths.ts 顶部)。
export {
  boundaryKey, isInsidePath, windowsPathRejection, windowsLongPathHint,
  PATH_DELIMITER, splitPathList, PATH_SEP, hostInfo, splitPathSegments,
} from "./platform-paths.js";
export type { HostInfo } from "./platform-paths.js";
