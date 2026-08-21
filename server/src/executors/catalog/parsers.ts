import { createInterface } from "node:readline";
import type { AgentEvent } from "@ash/shared";
import { RunTraceRecorder } from "../diagnostics.js";
import { forceFinishOnExit, spawnErrorMessage } from "../spawn.js";
import { parseClaudeStream } from "../claude.js";
import type { CliParser, CliParserContext } from "./types.js";

// ── 目录自带的输出解析器 ────────────────────────────────────────────────────
// spec 不声明 parser 时用 textParser;声明了就用它自己那份(可内联在 spec 文件里)。

// 控制序列(颜色、光标移动)。CLI 在非 TTY 下多半不上色,但不保证 —— 留着会让
// 转写出来的 Markdown 里全是 `ESC[32m` 这种噪声。
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[@-Z\\-_]/g;
const stripAnsi = (s: string) => s.replace(ANSI, "");

/**
 * 最保守的解析:stdout 逐行当 assistant 文本,退出码非 0 就报错。
 *
 * 适用于「只会往 stdout 打人话」的 CLI —— 也就是所有还没实测出结构化输出格式的
 * CLI 的安全起点:它不猜任何事件语义,所以不会把工具调用错报成正文,代价只是
 * timeline 里看不到工具调用与思考过程。
 *
 * 有结构化输出(json / stream-json)的 CLI 请在自己的 spec 里换掉它:输出格式跟
 * claude 一致的直接用 claudeStreamJsonParser,别的照 parsers.ts 的写法内联一份。
 */
export const textParser: CliParser = (ctx) => textEvents(ctx);

async function* textEvents(ctx: CliParserContext): AsyncIterable<AgentEvent> {
  const { child, bin, lifecycle } = ctx;
  const queue: AgentEvent[] = [];
  let resolve: (() => void) | null = null;
  let finished = false;
  const push = (e: AgentEvent) => {
    queue.push(e);
    resolve?.();
    resolve = null;
  };

  const trace = new RunTraceRecorder(ctx.trace);
  let stdoutLines = 0;
  let stderrTail = "";

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    trace.event(line);
    stdoutLines += 1;
    push({ kind: "text", text: stripAnsi(line) + "\n" });
  });
  child.stderr?.on("data", (d) => {
    const chunk = d.toString();
    stderrTail = (stderrTail + chunk).slice(-8000);
    trace.stderr(chunk);
  });

  // 收尾单点:三条路(spawn 失败 / close / exit 后流不收尾)都汇到这里,保证
  // 事件流一定以 done 结束 —— 少一个 done 就是任务永远卡 running。
  const finish = (opts: { exitStatus: number; spawnError?: string; flushTimeout?: boolean }) => {
    if (finished) return;
    finished = true;
    trace.close();
    const tail = stripAnsi(stderrTail).trim();
    if (opts.spawnError) push({ kind: "error", message: opts.spawnError });
    else if (opts.flushTimeout)
      push({ kind: "error", message: "进程已退出但输出流未正常收尾(疑有残留子进程占用管道),已强制结束本回合" });
    else if (!lifecycle.stopRequested && opts.exitStatus !== 0)
      push({
        kind: "error",
        message: tail
          ? `${ctx.label} 以 exit ${opts.exitStatus} 结束：${tail.slice(0, 2000)}`
          : `${ctx.label} 以 exit ${opts.exitStatus} 结束,且 stderr 为空(命令行参数可能不对)`,
      });
    else if (!lifecycle.stopRequested && opts.exitStatus === 0 && stdoutLines === 0)
      push({
        kind: "error",
        message:
          `${ctx.label} 以 exit 0 结束但没有任何 stdout 输出 —— 多半是非交互参数不对` +
          `(执行参数在 server/src/executors/catalog/ 下该 CLI 的 spec 里${tail ? `;stderr:${tail.slice(0, 500)}` : ""})`,
      });
    push({ kind: "done", exitStatus: opts.exitStatus });
    resolve?.();
    resolve = null;
  };

  child.on("error", (err: NodeJS.ErrnoException) => {
    finish({ exitStatus: 1, spawnError: spawnErrorMessage(bin, err) });
  });
  child.on("close", (code, signal) => {
    finish({ exitStatus: code ?? (signal ? 1 : 0) });
  });
  forceFinishOnExit(child, () => finished, (exit) => finish({ exitStatus: exit, flushTimeout: true }));

  while (true) {
    if (queue.length) {
      yield queue.shift()!;
      continue;
    }
    if (finished) return;
    await new Promise<void>((r) => (resolve = r));
  }
}

/**
 * claude 那套 `--output-format stream-json --verbose` 的解析(文本增量 + tool_use +
 * session_id + result)。**只在该 CLI 确实输出同一套 schema 时才用** —— claude Code
 * 的 fork 常常连输出格式一起继承,那时这份能直接白嫖工具调用与流式文本;schema 不
 * 一样就会一行都解析不出来,还不如 textParser。
 */
export const claudeStreamJsonParser: CliParser = (ctx) => parseClaudeStream(ctx.child, undefined, ctx.bin);
