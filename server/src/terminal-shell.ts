// 终端会话「怎么起 shell」这一半:shell 选型、常用命令的跑法、pty 环境变量、尺寸钳制、
// 工作目录解析。
// 会话生命周期(创建/清场/回收)在 terminal.ts,进程树/wrapper 纯函数在
// terminal-process-tree.ts。
import { existsSync, statSync } from "node:fs";
import { resolveBin } from "./executors/bin-resolve.js";
import { expandHome } from "./git.js";
import { IS_WINDOWS, encodePowerShellCommand } from "./platform.js";
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

/**
 * 跑一条「常用命令」用什么命令行(shared/src/project-commands.ts 的 service / commands)。
 *
 * POSIX:用户的 shell + `-lc <脚本>`。`-l` 是必须的 —— dev 命令的 PATH/nvm 全靠登录 shell。
 *
 * Windows:**PowerShell + `-EncodedCommand`**(UTF-16LE base64)。三点理由:
 *  ① 没有 `-l` 这一档(登录 shell 是 POSIX 概念),而那边的 PATH 本来就来自注册表 + 进程
 *     继承,nvm-windows 也是改 PATH —— 所以「登录 shell」要解决的问题在那边不存在;
 *  ② 脚本是用户写的整段文本(多行、引号、`$`、反引号),而 node-pty 要先把 args 拼成一条
 *     命令行、PowerShell 自己再解析一轮 —— 两层引号规则叠在一起是雷区(platform.ts 顶部
 *     那一节就是为它写的)。编码传参把整片雷区绕开,脚本里什么都不用转义;
 *  ③ 多行脚本 cmd.exe 收不了(`/c` 只认一行),所以找不到 PowerShell 一律**抛**,不悄悄
 *     换一套方言去跑 —— 那只会让一条写给 PowerShell 的脚本以看不懂的方式失败。
 *
 * 退出码要自己接:`-Command`/`-EncodedCommand` 只在最后一条是原生命令时才透传
 * `$LASTEXITCODE`,其余情形一律 0/1。所以脚本后面补一段确定性的收口,语义对齐
 * `sh -lc`:**最后一条语句的成败**就是会话的退出码(见 withExitCodeEpilogue)。
 *
 * 脚本方言两边因此是不同的(那边是 PowerShell),这点在设置页的说明里写明。
 */
export function commandLaunch(script: string, preferredShell?: string): { shell: string; args: string[] } {
  if (!IS_WINDOWS) {
    const shell = preferredShell ?? shellCommand().shell;
    return { shell, args: ["-lc", script] };
  }
  const exe = resolveBin("pwsh.exe") ?? resolveBin("powershell.exe");
  if (!exe) {
    throw new Error("这台 Windows 上找不到 PowerShell(pwsh.exe / powershell.exe)，常用命令无法运行");
  }
  return { shell: exe, args: ["-NoLogo", "-EncodedCommand", encodePowerShellCommand(withExitCodeEpilogue(script))] };
}

/**
 * 把「最后一条语句的成败」接出来,对齐 `sh -lc`(`false; echo hi` 退 0,因为最后一条是
 * `echo`)。
 *
 * **两个变量不是一回事,顺序是这段的全部内容**:
 *  · `$?` —— **上一条语句**的成败。cmdlet 和原生命令都更新它,所以它才是「最后一句怎么了」
 *    的那个读数;必须在任何别的语句之前抓住,读晚一句拿到的就是那句 `if` 自己的成败。
 *  · `$LASTEXITCODE` —— **最近一个原生命令**的退出码。它**有粘性**:脚本中途
 *    `node -e "process.exit(7)"` 失败之后,后面的 cmdlet 成功也不会清掉那个 7。
 *
 * 所以先认 `$?`:它说成功就退 0(第 1 轮审查 F3 —— 反过来写的话,「先失败、随后补救成功」
 * 的脚本会被那个粘住的 7 重新判成整段失败)。只有 `$?` 说失败时才去用 `$LASTEXITCODE`,
 * 这时它多半就是那条失败原生命令自己的码。
 *
 * 残留的一档如实说在这儿:最后一句是**失败的 cmdlet**、而脚本更早有过失败的原生命令时,
 * 退的是那个旧码而不是 1 —— 两者都非零,「成没成」这个判断不受影响,只是数字借了前一条。
 * 要分清得在每条语句之间插桩(得先解析 PowerShell 脚本),不值当。
 */
function withExitCodeEpilogue(script: string): string {
  return [
    "$global:LASTEXITCODE = 0",
    script,
    "$ok = $?",
    "$code = $LASTEXITCODE",
    "if ($ok) { exit 0 }",
    "if ($code -is [int] -and $code -ne 0) { exit $code }",
    "exit 1",
  ].join("\n");
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
