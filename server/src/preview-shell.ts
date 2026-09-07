// 生成出来的预览命令**最终交给哪门 shell 执行**，以及那门 shell 怎么写。
//
// 起因是一次漏判：识别出来的命令里把端口写成 `$PORT`，可 Windows 上这些命令是交给
// `cmd.exe /d /s /c` 跑的（platform.ts 的 userShellLaunch），而 cmd 只认 `%PORT%` ——
// `$PORT` 在那边是个字面量。于是 Windows 上凡是「端口写在命令行里」的那几门（vite /
// Angular / Django / FastAPI / Flask / Laravel / Rails）一律吃不到 ash 借的端口：轻则参数
// 报错，重则落到框架默认端口上干等 120 秒超时。同一条线上还有后台 `&`、`;` 和
// `FOO=1 cmd` 这些纯 POSIX 的写法，组合示例整条在 Windows 上都跑不了。
//
// 用户**自己填**的命令写成什么方言是他自己的事（platform.ts 顶部已经说明这一点），
// 但 **ash 自己生成的命令没有这个借口**。所以「怎么引用变量、怎么进目录、怎么丢后台、
// 怎么把几条接起来」全部收在这里按平台给一份。
//
// 全是纯字符串函数，两门方言都测得动（test:preview-command），不必真有一台 Windows
// ——「cmd 认不认这条命令」仍然得上真机，但「我们有没有把 `$` 写到 cmd 上去」不必。

export type ShellKind = "posix" | "cmd";

export interface PreviewShell {
  readonly kind: ShellKind;
  /** 引用一个环境变量：`$PORT` / `%PORT%`。 */
  ref(name: string): string;
  /** 把一个字面量（目录名、模块名）按这门 shell 的规矩引起来。 */
  quote(value: string): string;
  /** 路径分隔符按本地写法。 */
  path(value: string): string;
  /** 进目录再跑。 */
  cd(rel: string, command: string): string;
  /** 带一个环境变量跑。value 是**这门 shell 的表达式**（含 `$PORT2`/`%PORT2%`），不引。 */
  withEnv(name: string, value: string, command: string): string;
  /**
   * 丢后台。**可能为 null** —— 见 cmd 那一份的注释：有些命令在 cmd 上没法安全地写成
   * 一行后台任务，那时宁可不给，也不给一条粘过去就坏的。
   */
  background(command: string): string | null;
  /** 顺序接起来。 */
  join(commands: readonly string[]): string;
}

/** 不需要加引号的字面量：路径和模块名绝大多数长这样。 */
const POSIX_SAFE = /^[A-Za-z0-9_.\-/@+:=]+$/;
const CMD_SAFE = /^[A-Za-z0-9_.\-/\\@+:=]+$/;

function posixQuote(value: string): string {
  return POSIX_SAFE.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function cmdQuote(value: string): string {
  // Windows 的文件名里不可能有 `"`（系统直接不允许），所以裹一层双引号就够，不必转义。
  return CMD_SAFE.test(value) ? value : `"${value}"`;
}

const POSIX: PreviewShell = {
  kind: "posix",
  ref: (name) => `$${name}`,
  quote: posixQuote,
  path: (value) => value,
  cd: (rel, command) => `cd ${posixQuote(rel)} && ${command}`,
  withEnv: (name, value, command) => `${name}=${value} ${command}`,
  background: (command) => `(${command} &)`,
  // `( … &)` 是一个复合命令，POSIX shell 要求它后面跟分隔符，少一个分号整条命令连语法
  // 都过不了（`syntax error near unexpected token`）—— 而这条是直接给用户粘走的。
  join: (commands) => commands.join(" ; "),
};

const CMD: PreviewShell = {
  kind: "cmd",
  ref: (name) => `%${name}%`,
  quote: cmdQuote,
  path: (value) => value.replaceAll("/", "\\"),
  cd: (rel, command) => `cd /d ${cmdQuote(winPath(rel))} && ${command}`,
  // **不加引号**是有意的：`set "A=1"` 那个惯用写法一旦进了下面 background 的内层就要嵌套
  // 引号，cmd 的嵌套引号规则不可靠。不加引号时 `set A=1&&x` 里 `&&` 前**不能有空格**
  // —— 有空格的话那个空格会被算进变量值（cmd 的 set 取到行尾/`&` 为止）。
  withEnv: (name, value, command) => `set ${name}=${value}&&${command}`,
  /**
   * cmd 上丢后台必须开一个**独立的** cmd 会话：`cd` 和 `set` 在同一个会话里会漏给后面
   * 那条命令 —— 配角 `cd /d back` 之后，主角那条 `cd /d front` 就成了 `back\front`，
   * 必然找不到；配角设的 `SERVER_PORT` 也会被主角继承。
   *
   * 内层命令里出现 `"`（目录名带空格那种）就返回 null：`cmd /c "… "" …"` 的嵌套引号
   * 在 cmd 里没有可靠写法，与其给一条**看着像对**的坏命令，不如这一次不给示例。
   */
  background: (command) => command.includes("\"") ? null : `start "" /b cmd /c "${command}"`,
  join: (commands) => commands.join(" & "),
};

/** cmd 的 cd 要先把 `/` 换成 `\`。 */
function winPath(rel: string): string {
  return rel.replaceAll("/", "\\");
}

export function previewShell(platform: NodeJS.Platform = process.platform): PreviewShell {
  return platform === "win32" ? CMD : POSIX;
}
