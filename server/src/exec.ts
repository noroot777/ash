import {
  execFile,
  spawn,
  type ChildProcess,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { killTree } from "./platform.js";
import { IS_WINDOWS } from "./platform-os.js";
import { externalWaitBound } from "./external-wait-bound.js";

export interface ExecFileTextResult {
  stdout: string;
  stderr: string;
}

const seconds = (ms: number) => (ms < 1000 ? `${ms} 毫秒` : `${Math.round(ms / 1000)} 秒`);

/** `timeoutMs` 到点、命令被杀掉时抛的错。调用方据此分得清「它失败了」和「我们等不及了」。 */
export class ExecTimeout extends Error {
  /** 跟 execFile 自带超时给的错误同一个记号:读 `killed` 判「超时」的调用方(命令站的失败说明)不用改。 */
  readonly killed = true;
  constructor(readonly file: string, readonly args: readonly string[], readonly timeoutMs: number) {
    super(`${file} ${args.join(" ")} 超过 ${seconds(timeoutMs)}没有返回，已终止`);
    this.name = "ExecTimeout";
  }
}

type ExecTextOptions = ExecFileOptionsWithStringEncoding & { input?: string; timeoutMs?: number };
type Settle = (error: ExecFileException | null, stdout: string, stderr: string) => void;

/**
 * Run a background command and collect text output without creating a Windows
 * console window. The server normally runs detached, so the Node default would
 * otherwise give every short-lived console program its own conhost/OpenConsole.
 *
 * `timeoutMs`:到点就杀掉整棵进程树并以 `ExecTimeout` 拒绝。杀法与系统里其它命令超时相同
 * (`killTree`):POSIX 上让命令自成进程组(detached)、按组发信号,所以 git 起的 hook、
 * 外部 diff 辅助程序这些后代一并收掉;**主动脱离进程组的后代不在这个保证里**,跟全系统现状
 * 一致。Windows 不改起进程的方式(仍是 execFile),到点走 killTree 现有的 taskkill /T。
 * 不传时取所在收尾段圈定的时限(external-wait-bound.ts;调用方自己给了 Node 的 `timeout`
 * 就不套),都没有就不设时限(老行为)。
 */
export function execFileText(
  file: string,
  args: readonly string[],
  options: ExecTextOptions = {},
): Promise<ExecFileTextResult> {
  const { input, timeoutMs: explicit, ...rest } = options;
  // 调用方自己设了 Node 的 `timeout`(命令站的 20 分钟那一类)说明它有自己的上限,不拿段上的
  // 短时限去覆盖它。
  const scoped = explicit === undefined && rest.timeout === undefined ? externalWaitBound() : undefined;
  const timeoutMs = explicit ?? scoped?.ms;
  const bounded = timeoutMs !== undefined && timeoutMs > 0;
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    const settle: Settle = (error, stdout, stderr) => {
      if (timer) clearTimeout(timer);
      if (timedOut) return; // 到点那一刻已经结算过了
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    };
    // execFile 不把 `detached` 交给 spawn(它只转发一小撮选项),POSIX 上要按进程组杀就得自己起。
    const child = bounded && !IS_WINDOWS
      ? spawnInOwnGroup(file, args, rest, settle)
      : execFile(file, [...args], { ...rest, encoding: rest.encoding ?? "utf8", windowsHide: true }, settle);
    if (bounded) {
      // 到点**当场**结算,不等子进程的输出管道关上:脱离了进程组的后代要是还攥着管道,
      // 关闭事件就永远不来,等它等于把时限又交回给那个后代。
      timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) killTree(child.pid, "SIGKILL");
        else child.kill("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        const timeout = new ExecTimeout(file, args, timeoutMs!);
        scoped?.onTimeout(timeout.message);
        reject(timeout);
      }, timeoutMs);
      timer.unref?.();
    }
    // 有 input 就整份写进 stdin 再关上（路径清单这类可能撑爆命令行长度的参数走这里）。子进程没读完
    // 就退出时写端会报 EPIPE：那是流上的 error 事件，不接住就是未捕获异常；命令本身的失败由上面的
    // 回调照常结算，这里只收下它。
    //
    // 没有 input 也要**当场关上**:execFile 默认给子进程一根开着的 stdin 管道,而调用方拿不到 child、
    // 永远不会往里写。于是任何读 stdin 的东西 —— git 跑的仓库 hook(`read` 等确认)、要交互的凭据
    // helper —— 会一直等一个不会来的 EOF,这次调用永不返回。回合收尾里就有这类 git 调用(工作区
    // 快照),它们一挂,回合锁就一直放不掉。关上之后读的一方立刻读到 EOF,按它自己的「没有输入」处理。
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

/**
 * 带时限时的 POSIX 起法:命令自成进程组,输出照 execFile 的口径收(编码、maxBuffer、失败时的
 * 错误形状 —— 调用方读的 `code`/`stderr`/`message` 跟 execFile 给的一样)。
 */
function spawnInOwnGroup(
  file: string,
  args: readonly string[],
  options: Omit<ExecTextOptions, "input" | "timeoutMs">,
  settle: Settle,
): ChildProcess {
  const encoding = options.encoding ?? "utf8";
  const maxBuffer = options.maxBuffer ?? 1024 * 1024; // execFile 的默认值
  const child = spawn(file, [...args], {
    cwd: options.cwd, env: options.env, uid: options.uid, gid: options.gid, shell: options.shell,
    detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  let size = 0;
  let failure: ExecFileException | null = null;
  const text = (stream: "stdout" | "stderr") => Buffer.concat(chunks[stream]).toString(encoding);
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]?.on("data", (chunk: Buffer) => {
      if (failure) return;
      size += chunk.length;
      if (size > maxBuffer) {
        failure = Object.assign(new RangeError(`${stream} maxBuffer length exceeded`),
          { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }) as unknown as ExecFileException;
        if (child.pid) killTree(child.pid, "SIGKILL");
        return;
      }
      chunks[stream].push(chunk);
    });
  }
  child.once("error", (error) => {
    failure ??= error as ExecFileException;
    settle(failure, text("stdout"), text("stderr"));
  });
  child.once("close", (code, signal) => {
    if (failure) { settle(failure, text("stdout"), text("stderr")); return; }
    if (code === 0) { settle(null, text("stdout"), text("stderr")); return; }
    const stderr = text("stderr");
    const cmd = [file, ...args].join(" ");
    settle(Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), {
      code: code ?? undefined, signal: signal ?? undefined, killed: false, cmd,
    }) as ExecFileException, text("stdout"), stderr);
  });
  return child;
}
