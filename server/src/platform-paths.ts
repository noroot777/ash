// 平台差异里**纯路径/字符串**的那一半:边界比较、Windows 长路径、PATH 拆分、
// 「server 跑在哪台机器上」、用户自己写的那条命令行。
//
// 为什么跟 platform.ts 分家:那边是**系统调用**(进程表、击杀、端口占用者),这边一个
// 系统调用都不发,全是纯函数 —— 两摊的测试方式、改动频率都不一样,而合在一份文件里已经
// 顶到 700 行上限(全局约定)。**对外仍然只有 platform.ts 一个门**:它原样转出这里的每
// 一个名字,所以既有的二十来个使用方一行都不用改。
import { homedir } from "node:os";

import { IS_WINDOWS } from "./platform-os.js";

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
// ash 的 worktree 落在 `<repo>\.worktrees\<taskId>`,比主仓深两层,agent 进去
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
    "改完要重开终端和 ash;还不行就把项目挪到更短的路径下(比如 C:\\code\\<项目>)。",
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
 * ash 是完全正常的用法,那时该显示的是 mac 的路径形状:项目目录在服务端。
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
 * UI 上把这件事说清楚,别让用户以为是 ash 坏了。
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
