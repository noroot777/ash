// 终端会话「怎么起 shell」这一半:shell 选型、pty 环境变量、尺寸钳制、工作目录解析。
// 会话生命周期(创建/清场/回收)在 terminal.ts,进程树/wrapper 纯函数在
// terminal-process-tree.ts。
import { existsSync, statSync } from "node:fs";
import { resolveBin } from "./executors/bin-resolve.js";
import { expandHome } from "./git.js";
import { IS_WINDOWS } from "./platform.js";
import { LSOF_PATH, PS_PATH } from "./terminal-process-tree.js";

export function terminalSize(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;
}

/**
 * 起一个交互 shell 用什么命令。
 *
 * POSIX:`$SHELL`,回退 zsh / bash,带 `-l` 走登录 shell(用户的 PATH、nvm、rbenv
 * 这些全靠它)。
 *
 * Windows:**没有 `-l` 这一档**,登录 shell 是 POSIX 概念,PowerShell 会把它当成
 * 一个位置参数、当脚本名去找,直接起不来。回退顺序按「用户更可能想要哪个」排:
 * PowerShell 7(`pwsh`)→ 随系统自带的 Windows PowerShell 5.1 → `cmd`。`$SHELL`
 * 在 Windows 上基本只由 Git Bash 之类的环境设置,而且往往是一条 MSYS 风格的路径
 * (`/usr/bin/bash`),ConPTY 起不了 —— 所以那边不认它。
 */
export function shellCommand(): { shell: string; args: string[] } {
  if (IS_WINDOWS) {
    for (const candidate of ["pwsh.exe", "powershell.exe", "cmd.exe"]) {
      const resolved = resolveBin(candidate);
      if (resolved) return { shell: resolved, args: [] };
    }
    // 一个都没解析到(PATH 被改坏了)也别抛:交给 ConPTY 自己去找,起不来会走
    // onExit,前端至少能看见退出码,比这里直接 500 强。
    return { shell: "cmd.exe", args: [] };
  }
  const shell = process.env.SHELL || (existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash");
  return { shell, args: ["-l"] };
}

export function ptyEnvironment(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    ...env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    ASH_TERMINAL: "1",
    // wrapper 清杀/守护时排除 server 自己(它持有全部 pty master,macOS 的 lsof
    // 会把 master 端也列进 /dev/ttysN 的持有者 —— 不排除等于让 wrapper 杀掉 ash)。
    ASH_PTY_PARENT: String(process.pid),
    // ps/lsof 的绝对路径(启动时解析,含 /bin、/usr/sbin 兜底):wrapper 不吃运行时 PATH。
    ASH_PS: PS_PATH ?? "",
    ASH_LSOF: LSOF_PATH ?? "",
  };
}

export function resolveTerminalDirectory(repoPath: string | null | undefined): string | null {
  const resolved = expandHome(repoPath);
  try { return resolved && statSync(resolved).isDirectory() ? resolved : null; } catch { return null; }
}
