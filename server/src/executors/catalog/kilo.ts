import { createInterface } from "node:readline";
import type { AgentEvent } from "@ash/shared";
import { RunTraceRecorder } from "../diagnostics.js";
import { forceFinishOnExit, spawnErrorMessage } from "../spawn.js";
import type { CliParser, CliParserContext, CliSpec } from "./types.js";

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分按 2026-07-30 的官方文档
// (kilo.ai/docs/.../cli 与 cli-reference)+ GitHub Kilo-Org/kilocode main 分支源码
// packages/opencode/src/cli/cmd/run.ts 逐项核对,**本机没装 kilo、一次都没实跑**,
// 所以 untested 保留。
export const kiloSpec: CliSpec = {
  key: "kilo",
  name: "Kilo CLI",
  description: "开源多模型 CLI",
  bins: ["kilo"], // 包名是 @kilocode/cli,命令是 kilo。
  docsUrl: "https://kilo.ai/docs/code-with-ai/platforms/cli",
  installCommand: "npm install -g @kilocode/cli",
  untested: true,
  notes:
    "依据(2026-07-30 查阅 kilo.ai/docs/code-with-ai/platforms/cli 与 .../cli-reference," +
    "并对着 GitHub Kilo-Org/kilocode main 分支的 packages/opencode/src/cli/cmd/run.ts 源码逐项核对;" +
    "npm @kilocode/cli 当时 latest=7.4.17,发布于 2026-07-29,所以 main 的源码≈装机版本):" +
    "①**Kilo CLI 是 OpenCode 的 fork**(官方文档原话),`kilo run [message..]` 就是 opencode 的 run," +
    "非交互一次性执行走它;`--interactive` 默认 false,不给就是无头模式。" +
    "②`--auto` 才自动批准 —— 源码 permission.asked 分支里,给了 --auto 就对本会话及其 task 子会话" +
    "统一 `reply:\"once\"`;**不给会 auto-reject 并把整轮判失败**(\"run ended with an auto-rejected " +
    "permission; pass --auto for autonomous use\"),不是卡住而是白跑一轮。另有 `--dangerously-skip-permissions`" +
    "(只批准「未被显式 deny」的),自动化场景 --auto 更彻底,选它。" +
    "③`--format json` 输出 JSONL,schema 与 opencode 同源、与 claude 的 stream-json **完全不同**" +
    "(每行 `{type,timestamp,sessionID,part|error}`,type ∈ text/reasoning/tool_use/step_start/step_finish/error)," +
    "所以内联了自己的 parser,不能用 claudeStreamJsonParser;`--thinking` 是 reasoning 事件的开关" +
    "(非交互下默认 false,要显式给)。`--interactive` 与 `--format json` 互斥,我们不带 --interactive,不冲突。" +
    "④prompt 走 **stdin**:源码 loadInput() 里 `process.stdin.isTTY ? undefined : await Bun.stdin.text()`," +
    "再由 resolveRunInput(位置参数, 管道)合并 —— 没有位置参数时管道内容就是整条 message。" +
    "选 stdin 而不是位置参数,是为了绕开 argv 长度上限和「正文以 - 开头被当 flag」。" +
    "注意 `-p` 在 kilo run 里是 **--password**(basic auth),千万别拿它当 prompt flag。" +
    "⑤`--model/-m` 是 `provider/model` 形式(源码 parseModel 按第一个 / 切分,不带 / 会切出空 modelID)," +
    "所以预设一律带前缀;`kilo models` 列本机实际可用的全集(取决于 /connect 认证了哪些 provider)。" +
    "⑥`--variant` 才是思考强度(源码 describe:\"provider-specific reasoning effort, e.g., high, max, minimal\")," +
    "档位由 provider 决定,不合法组合由上游拒;没有 1.5x 加速档。" +
    "⑦sessionID 由 CLI 自己产生,每条 json 事件都带 `sessionID`,靠 parser 发 {kind:\"session\"} 带回来," +
    "再用 `--session/-s <id>` 续跑;TUI 也认 `--session`(tui.ts 里同名同 alias),所以恢复命令给 `kilo --session <id>`。" +
    "⑧`--replay`(默认 true)只喂 runInteractiveMode/runInteractiveLocalMode,**非交互路径根本不读它**," +
    "所以不会像 opencode 那样担心续跑时把历史重播成 text 事件。" +
    "⑨relay 故意没写:kilo 的自定义 provider(baseURL / apiKey)配在 ~/.config/kilo/kilo.jsonc 的 provider.* 里," +
    "文档只给了 `KILO_PROVIDER`(选 provider id)、`KILO_API_KEY`(映射 apiKey)这类字段级环境变量," +
    "**没有一个确定的「改 base url」环境变量**;拿半截配置去撞端点不如让它用自己的账号。" +
    "(线索:`KILO_CONFIG` / `KILO_CONFIG_CONTENT` 能整份注入可信配置,将来接 relay 大概率走这条,但没验证过。)" +
    "仍未确认(装了 CLI 后优先验这几条):" +
    "①stdin 通道在**装机版本**上是否真的生效 —— 万一那版还没有,表现是 exit 1 + " +
    "\"You must provide a message or a command\"(下面的 parser 会把 stderr 原样带出来),届时把 prompt 改成 `{via:\"arg\"}` 即可;" +
    "②`--model` 的 provider 前缀:文档里 Kilo 网关的自动档写作 `kilo-auto/frontier`,但没核实 CLI 侧" +
    "是否真有一个叫 `kilo-auto` 的 provider(也可能要写成 `kilocode/kilo-auto/frontier`),先按文档原样放进预设;" +
    "③`--variant` 在 kilo 网关模型上的合法档位集合(预设按 opencode 的并集给);" +
    "④首轮拿到的 sessionID 能否跨进程被 `--session` 找回(opencode 那边是 `ses_…`);" +
    "⑤npm 包同时装了 `kilocode` 这个别名 bin(package.json 的 bin 有两项),bins 只登记了 `kilo`,够用;" +
    "⑥源码里 `session.status=idle` 会直接 break 事件循环(与 opencode 同款早退),可能丢掉最后的 step_finish/用量统计," +
    "对本 parser 无影响(不依赖 step_finish 收口)。",
  exec: {
    subcommand: ["run"],
    // --auto:自动批准全部权限(不给它 = 工具调用被 auto-reject,整轮判失败)。
    // --format json:JSONL 事件流,给下面的 parser 用。--thinking:开 reasoning 事件。
    baseArgs: ["--auto", "--format", "json", "--thinking"],
    // 源码 loadInput():非 TTY 的 stdin 会被整份读进来当 message。比位置参数稳
    // (不撞 argv 上限、正文以 - 开头也不会被当 flag)。注意 -p 是 --password,不是 prompt。
    prompt: { via: "stdin" },
    model: { flag: "--model" },
    // kilo 把「思考强度」叫 variant(provider-specific reasoning effort),沿用 opencode。
    reasoningEffort: { flag: "--variant" },
    // id 由 CLI 自己产生,parser 负责发 {kind:"session"} 带回来;交互式恢复走 TUI 的
    // --session(run 与 tui 都认这个 flag 及其 -s 别名)。
    session: {
      resumeArgs: (id) => ["--session", id],
      interactive: (id) => `kilo --session ${id}`,
    },
    parser: (ctx) => kiloEvents(ctx),
  },
};

/**
 * `kilo run --format json` 的 JSONL 解析。
 *
 * 事件由 run.ts 的 `emit(type, data)` 统一写出,形状固定是
 * `{ type, timestamp, sessionID, ...data }`,六种 type:
 *   text          part.text —— 已完成的整块正文(gate 是 part.time.end,不是增量)
 *   reasoning     part.text —— 思考块,只在带 --thinking 时发
 *   tool_use      part.tool / part.state.{status,title,input,error} —— 工具跑完(completed/error)才发
 *   step_start / step_finish   步骤边界(含 cost/tokens),这里不需要
 *   error         session.error 的 `{ name, data?: { message? } }`
 *
 * 解析不出 JSON 的行**退回当正文**:装机版本万一不认 `--format json`(或往 stdout
 * 打了别的东西),这样至少还等于 textParser,而不是一行都看不见。
 */
const kiloEvents: CliParser = async function* (ctx: CliParserContext): AsyncIterable<AgentEvent> {
  const { child, bin, label, lifecycle } = ctx;
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
  let sawError = false;
  let sessionSent = false;

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    trace.event(line);
    if (!line.trim()) return;
    stdoutLines += 1;
    // 一行脏数据不许炸掉整个回合 —— 解析失败就当正文。
    let ev: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ev = parsed as Record<string, unknown>;
    } catch {
      ev = null;
    }
    if (!ev || typeof ev.type !== "string") {
      push({ kind: "text", text: line + "\n" });
      return;
    }

    if (!sessionSent && typeof ev.sessionID === "string" && ev.sessionID) {
      sessionSent = true;
      push({ kind: "session", cliSessionId: ev.sessionID });
    }

    const part = (ev.part ?? {}) as Record<string, unknown>;
    switch (ev.type) {
      case "text": {
        const text = typeof part.text === "string" ? part.text : "";
        if (text) push({ kind: "text", text: text.endsWith("\n") ? text : text + "\n" });
        break;
      }
      case "reasoning": {
        const text = typeof part.text === "string" ? part.text : "";
        if (text) push({ kind: "thinking", text });
        break;
      }
      case "tool_use": {
        const state = (part.state ?? {}) as Record<string, unknown>;
        const name = typeof part.tool === "string" ? part.tool : "tool";
        push({ kind: "tool", name, detail: toolDetail(state) });
        break;
      }
      case "error": {
        sawError = true;
        if (!lifecycle.stopRequested) push({ kind: "error", message: errorMessage(ev.error) });
        break;
      }
      // step_start / step_finish(以及将来新增的 type)只落 trace,不进时间线。
      default:
        break;
    }
  });

  child.stderr?.on("data", (d) => {
    const chunk = d.toString();
    stderrTail = (stderrTail + chunk).slice(-8000);
    trace.stderr(chunk);
  });

  // 收尾单点:三条路(spawn 失败 / close / exit 后流不收尾)都汇到这里,保证事件流
  // 一定以 done 结束 —— 少一个 done 就是任务永远卡 running。
  const finish = (opts: { exitStatus: number; spawnError?: string; flushTimeout?: boolean }) => {
    if (finished) return;
    finished = true;
    trace.close();
    const tail = stderrTail.trim();
    if (opts.spawnError) push({ kind: "error", message: opts.spawnError });
    else if (opts.flushTimeout)
      push({ kind: "error", message: "进程已退出但输出流未正常收尾(疑有残留子进程占用管道),已强制结束本回合" });
    else if (!lifecycle.stopRequested && opts.exitStatus !== 0 && !sawError)
      // 已经从 error 事件报过一次的就不再重复(会话级失败时 kilo 自己也会 exit 1)。
      push({
        kind: "error",
        message: tail
          ? `${label} 以 exit ${opts.exitStatus} 结束：${tail.slice(0, 2000)}`
          : `${label} 以 exit ${opts.exitStatus} 结束,且 stderr 为空(命令行参数可能不对)`,
      });
    else if (!lifecycle.stopRequested && opts.exitStatus === 0 && stdoutLines === 0)
      push({
        kind: "error",
        message:
          `${label} 以 exit 0 结束但没有任何 stdout 输出 —— 多半是非交互参数不对` +
          `(执行参数在 server/src/executors/catalog/kilo.ts${tail ? `;stderr:${tail.slice(0, 500)}` : ""})`,
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
};

// 工具事件的一行摘要:优先用 CLI 自己给的 title,没有就退回入参。
function toolDetail(state: Record<string, unknown>): string | undefined {
  const title = typeof state.title === "string" ? state.title : "";
  const failed = state.status === "error";
  const base = title || summarizeInput(state.input);
  if (!base) return failed ? "失败" : undefined;
  return failed ? `失败：${base}` : base;
}

function summarizeInput(input: unknown): string {
  if (typeof input === "string") return clip(input);
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  for (const k of ["command", "filePath", "path", "pattern", "url", "description"]) {
    if (typeof obj[k] === "string" && obj[k]) return clip(obj[k] as string);
  }
  return clip(JSON.stringify(obj));
}

// error 事件没有 part,形状是 { name, data?: { message? } }(run.ts 直接把
// session.error 的 properties.error 原样 emit 出来)。
function errorMessage(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "kilo 报告了一个未知错误";
  const err = raw as Record<string, unknown>;
  const name = typeof err.name === "string" ? err.name : "";
  const data = (err.data ?? {}) as Record<string, unknown>;
  const msg = typeof data.message === "string" ? data.message : "";
  return [name, msg].filter(Boolean).join("：") || "kilo 报告了一个未知错误";
}

const clip = (s: string) => (s.length <= 200 ? s : s.slice(0, 200) + "…");
