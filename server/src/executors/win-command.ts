// Windows 上「怎么把一串 args 变成命令行」的单点。
//
// 三件事在 Windows 上跟 POSIX 完全不同,任何一条搞错都不是「不好看」而是「跑错命令」:
//
// ① **`.cmd` / `.bat` 不能直接 spawn**。CVE-2024-27980 之后 Node 拒绝在没有
//    `shell: true` 的情况下执行批处理 —— 因为批处理的参数由 cmd.exe 二次解析,
//    朴素转义会被 `&`、`|`、`^` 打穿。而 npm 装的 CLI(claude / codex / gemini …)
//    在 Windows 上**正是** `.cmd` 垫片。
//
// ② 所以首选根本不是转义,而是**绕开垫片**:npm 的 `.cmd` 里写着它要跑的真实
//    脚本路径,把那条路径挖出来直接 `node <script>`,cmd.exe 完全不参与,
//    转义问题不存在。见 bin-resolve.ts 的 unwrapNpmShim。
//
// ③ 挖不出来才退到 cmd.exe。这时用的是 Rust 标准库修 CVE-2024-24576 时那套算法:
//    每个参数整体加引号、内部 `"` 前补足反斜杠再翻倍、含换行的参数直接拒绝
//    (换行在 cmd 里无法转义,只能拒收)。`%VAR%` 仍会被 cmd 展开,这一条**不能**
//    消除 —— 引号内的 `%` 没有转义写法。它只会把已存在的环境变量值代进去,
//    不构成命令注入,但如实记在这里。

/** 参数里带换行 —— cmd.exe 无法转义,只能拒绝。 */
export class UnquotableArgumentError extends Error {
  constructor(public readonly arg: string) {
    super(`参数含换行符，Windows 批处理无法安全传递：${JSON.stringify(arg.slice(0, 80))}`);
    this.name = "UnquotableArgumentError";
  }
}

/**
 * 按 CommandLineToArgvW 的反斜杠/引号规则给单个参数加引号,再按 cmd.exe 的规则
 * 把内部的 `"` 翻倍。空参数也必须加引号,否则会在解析时整个消失。
 */
function quoteForCmd(arg: string): string {
  if (/[\r\n]/.test(arg)) throw new UnquotableArgumentError(arg);
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes += 1;
      out += ch;
      continue;
    }
    if (ch === '"') {
      // 内部引号前的反斜杠要翻倍(它们本身是字面量),然后把引号自己也翻倍。
      out += "\\".repeat(backslashes) + '"';
    }
    backslashes = 0;
    out += ch;
  }
  out += "\\".repeat(backslashes) + '"';
  return out;
}

/**
 * 组装 `cmd.exe /d /s /c "…"` 的调用。
 * `/d` 跳过 AutoRun 注册表项(否则用户机器上任何 AutoRun 脚本都会先跑一遍),
 * `/s` 让 cmd 只剥掉最外层的一对引号、中间原样保留 —— 这正是我们要的语义。
 * 返回的 args 必须配 `windowsVerbatimArguments: true`,否则 Node 会再转义一轮。
 */
export function cmdExeLaunch(batchPath: string, args: string[]): {
  file: string;
  args: string[];
  windowsVerbatimArguments: true;
} {
  const line = [batchPath, ...args].map(quoteForCmd).join(" ");
  return {
    file: process.env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}
