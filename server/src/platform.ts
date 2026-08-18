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
import { homedir } from "node:os";

export const IS_WINDOWS = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";

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
export function powerShell(script: string, timeoutMs = 10_000): Promise<string> {
  const exe = powerShellExe();
  if (!exe) return Promise.resolve("");
  return new Promise((resolve) => {
    execFile(
      exe,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeCommand(script)],
      { timeout: timeoutMs, maxBuffer: 16 << 20, windowsHide: true },
      (_err, stdout) => resolve(stdout || ""),
    );
  });
}

// ── 进程表 ────────────────────────────────────────────────────────────────

export type ProcessRow = {
  pid: number;
  ppid: number;
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

function parseRows(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({
      pid,
      ppid: Number.isInteger(ppid) ? ppid : 0,
      startedAt: parts[2]!.trim() || null,
      command: parts.slice(3).join("\t").trim(),
    });
  }
  return rows;
}

const POSIX_PS_ARGS = ["-ww", "-axo", "pid=,ppid=,command="];

function parsePosixPs(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), startedAt: null, command: m[3]! });
  }
  return rows;
}

/**
 * 全表快照(pid / ppid / 命令行)。**startedAt 只有 Windows 那支填得上** —— POSIX 这支
 * 为了跟历史口径一致仍用 `ps -axo pid=,ppid=,command=`,要启动时间请单独调
 * `inspectProcess`(它按单个 pid 问,带 lstart)。
 * 查不到一律空数组:系统探测失败不该拖垮调用方。
 */
export async function listProcesses(timeoutMs = 3000): Promise<ProcessRow[]> {
  if (IS_WINDOWS) return parseRows(await powerShell(PS_PROCESS_SCRIPT, timeoutMs));
  const text = await new Promise<string>((resolve) => {
    execFile("ps", POSIX_PS_ARGS, { timeout: timeoutMs, maxBuffer: 8 << 20 }, (_e, stdout) =>
      resolve(stdout || ""),
    );
  });
  return parsePosixPs(text);
}

/** 单个进程的启动时间 + 命令行。查不到返回 null(调用方一律按「不存在」处理)。 */
export function inspectProcessSync(pid: number): { startedAt: string | null; command: string | null } | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (IS_WINDOWS) {
    // PowerShell 冷启动是百毫秒量级。这条只在「拿锁 / 重启接管」这类低频路径上跑,
    // 不在热路径 —— 真挪到热路径前先测一次。
    const out = powerShellSync(
      PS_PROCESS_SCRIPT.replace("Get-CimInstance Win32_Process -ErrorAction Stop", `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop`)
        .replace("Get-WmiObject Win32_Process", `Get-WmiObject Win32_Process -Filter "ProcessId=${pid}"`),
    );
    const row = parseRows(out).find((r) => r.pid === pid);
    return row ? { startedAt: row.startedAt, command: row.command || null } : null;
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

// ── 路径边界 ───────────────────────────────────────────────────────────────

/**
 * 把路径归一成「用来比边界」的键。
 *
 * NTFS **大小写不敏感**:`C:\Foo` 和 `c:\foo` 是同一个目录。直接 startsWith 比较
 * 会两头出错 —— 既误拒(用户输入的盘符大小写不同就被判越界),又是绕过面(把
 * 边界校验当成大小写敏感来写,攻击者换个大小写就绕过了同一道校验的另一处)。
 * 所以 Windows 上比较前一律过这个函数;POSIX 上原样返回(那里大小写是有意义的)。
 *
 * 只做大小写归一,**不做 realpath** —— 真实路径解析在调用点已经做了(而且必须在
 * 这之前做,8.3 短名要靠 realpath 才能展开)。
 */
export function boundaryKey(p: string): string {
  return IS_WINDOWS ? p.toLowerCase() : p;
}

/** target 是不是落在 root 之内(含等于)。跨平台的边界判定单点。 */
export function isInsidePath(root: string, target: string, sep: string): boolean {
  const r = boundaryKey(root);
  const t = boundaryKey(target);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Windows 专属的路径拒绝面。**必须在 realpath 之后调用**:realpath 会把 8.3 短名
 * (`PROGRA~1`)展开成长名,所以这里只需要挡住 realpath 挡不住的那两类。
 *  · UNC / 网络路径(`\\server\share`、`\\?\`、`\\.\`):不在任何本机 root 之下,
 *    却能靠 `\\?\C:\` 这类前缀绕过朴素的前缀比较。
 *  · 仍带 `~N` 的短名(realpath 没能展开,比如目标不存在时)。
 * 返回拒绝理由,通过为 null。
 */
export function windowsPathRejection(absPath: string): string | null {
  if (!IS_WINDOWS) return null;
  if (/^[\\/]{2}/.test(absPath)) return "不接受 UNC / 网络路径";
  if (/(^|[\\/])[^\\/]{1,8}~\d(\.[^\\/]{1,3})?([\\/]|$)/.test(absPath)) return "不接受 8.3 短文件名";
  return null;
}

// ── Windows 长路径(MAX_PATH) ──────────────────────────────────────────────
//
// harness 的 worktree 落在 `<repo>\.worktrees\<taskId>`,比主仓深两层,agent 进去
// 再装一遍 node_modules —— 260 字符的老上限在这条链路上是**最容易先撞到的一堵墙**。
// 要点是两个开关缺一不可,而且第二个经常被漏:
//  · 系统侧 `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled=1`
//  · git 侧 `core.longpaths=true` —— Git for Windows 走自带的 msys 运行时,**不看**
//    系统开关,只看这个配置。只开注册表的话 `git worktree add` 照样报 Filename too long。
// Node 自己给 fs 调用加 `\\?\` 前缀,基本不受 260 限制,所以服务端只需要管 git 这侧。
//
// 探测放在 `scripts/setup.mjs`(那里用户能当场照着命令改);这里只在 git **已经报错**
// 时补一句人话 —— 不预先拦截,因为路径长不等于一定失败,误判成硬失败比报错难懂更贵。

const WINDOWS_MAX_PATH = 260;
/** 超过这个长度就当「深到该提一句」——留 60 字符给 worktree 里面的相对路径。 */
const LONG_PATH_ALERT = WINDOWS_MAX_PATH - 60;

/**
 * git 操作失败时,判断要不要补一段长路径的排查提示。非 Windows 一律 null。
 * `stderr` 明说 too long 时是确定的;只是路径本身够深时也给,但措辞留有余地。
 */
export function windowsLongPathHint(targetPath: string, stderr = ""): string | null {
  if (!IS_WINDOWS) return null;
  const tooLong = /too long|ENAMETOOLONG|文件名(过|太)长/i.test(stderr);
  if (!tooLong && targetPath.length <= LONG_PATH_ALERT) return null;
  return [
    `Windows 的 MAX_PATH 是 ${WINDOWS_MAX_PATH},这条路径已经 ${targetPath.length} 字符 —— 深路径是这里最常见的失败原因。两个开关缺一不可:`,
    "  · 管理员 PowerShell:Set-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem' LongPathsEnabled 1",
    "  · git config --global core.longpaths true",
    "改完要重开终端和 harness;还不行就把项目挪到更短的路径下(比如 C:\\code\\<项目>)。",
  ].join("\n");
}

// ── PATH 拆分 ──────────────────────────────────────────────────────────────

/**
 * PATH 的分隔符。**故意不用 `path.delimiter`** —— 那个值由 Node 启动时的真实平台
 * 定死,测试里没法把它跟 IS_WINDOWS 一起翻转,于是 Windows 分支在 mac 上就成了
 * 「跑得到但测的是混血逻辑」。这里显式跟着 IS_WINDOWS 走,两边同时可控。
 */
export const PATH_DELIMITER = IS_WINDOWS ? ";" : ":";

/**
 * 拆 PATH。**必须用 PATH_DELIMITER**:Windows 是 `;`,按 `:` 拆会把 `C:\...` 的
 * 盘符切成两半 —— 每个目录都变成不存在的路径,所有 CLI 一律「找不到」。
 */
export function splitPathList(value: string | undefined | null): string[] {
  return (value ?? "").split(PATH_DELIMITER).map((s) => s.trim()).filter(Boolean);
}

/** 路径分隔符。同样跟着 IS_WINDOWS 走,理由见 PATH_DELIMITER。 */
export const PATH_SEP = IS_WINDOWS ? "\\" : "/";

// ── 「server 跑在哪台机器上」 ──────────────────────────────────────────────

export interface HostInfo {
  /** `process.platform` 原文;前端只用它分「Windows / 其它」。 */
  platform: string;
  /** 路径分隔符(`\` 或 `/`)。 */
  sep: string;
  /** 当前用户家目录绝对路径。 */
  home: string;
}

/**
 * 前端要按**这台机器**给路径提示(新建项目的占位符、把家目录缩写成 `~`)。
 * 浏览器自己的 `navigator.platform` 不算数 —— 用 Windows 上的浏览器连 mac 上的
 * harness 是完全正常的用法,那时该显示的是 mac 的路径形状:项目目录在服务端。
 */
export function hostInfo(): HostInfo {
  return { platform: process.platform, sep: PATH_SEP, home: homedir() };
}

/** 按两种分隔符一起切路径 —— Windows 上 `/` 和 `\` 都合法,只认一种会漏。 */
export function splitPathSegments(p: string): string[] {
  return p.split(IS_WINDOWS ? /[\\/]+/ : /\/+/).filter(Boolean);
}

// ── 用户自己写的那条命令行 ─────────────────────────────────────────────────

/**
 * 跑一条**用户自己写的命令行**(预览命令、workflow 的 cmd 步骤)时该 spawn 什么。
 *
 * POSIX:`sh -lc <cmd>`。`-l` 是有意的 —— 用户的 PATH 往往由 nvm / rbenv /
 * `.zprofile` 撑起来,不走登录 shell 的话 `npm run dev` 常常直接 command not found。
 *
 * Windows:`%COMSPEC% /d /s /c "<cmd>"` + `windowsVerbatimArguments`。逐项理由:
 *  · **不用 PowerShell**。Windows PowerShell 5.1 不认 `&&`(7 才支持),而
 *    `npm run build && npm start` 是预览命令里最常见的写法之一,换过去等于挑一批
 *    现成的命令来弄坏。cmd 的兼容面更宽。
 *  · `/d` 跳过 AutoRun 注册表项,`/s` 只剥掉最外层那一对引号 —— 所以外面这层
 *    `"…"` 加得刚好:cmd 剥掉它之后拿到的就是用户原样的命令行。
 *  · verbatim 是必须的:不开的话 Node 会按 CommandLineToArgvW 的规则再转义一轮,
 *    用户命令里的引号会被 `\"` 掉,cmd 不认这种写法。
 *
 * **仍然会跑不通的一类**:命令本身写的是 POSIX 语法(`FOO=1 cmd`、`$(…)`、
 * `2>/dev/null`、`ls | grep`)。这不是这里能修的 —— 那是另一门语言。调用方要在
 * UI 上把这件事说清楚,别让用户以为是 harness 坏了。
 */
export function userShellLaunch(cmd: string): {
  file: string;
  args: string[];
  windowsVerbatimArguments?: true;
} {
  if (!IS_WINDOWS) return { file: "sh", args: ["-lc", cmd] };
  return {
    file: process.env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", `"${cmd}"`],
    windowsVerbatimArguments: true,
  };
}
