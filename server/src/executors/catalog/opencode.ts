import { createInterface } from "node:readline";
import type { AgentEvent } from "@harness/shared";
import { RunTraceRecorder } from "../diagnostics.js";
import { forceFinishOnExit, spawnErrorMessage } from "../spawn.js";
import type { CliParser, CliParserContext, CliSpec } from "./types.js";

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分按 2026-07-30 的官方 docs
// (opencode.ai/docs/cli)与 dev 分支源码(packages/opencode/src/cli/cmd/run.ts)校准,
// **本机未装、未实测**,所以 untested 保留。
export const opencodeSpec: CliSpec = {
  key: "opencode",
  name: "OpenCode",
  description: "开源终端智能体",
  bins: ["opencode"],
  docsUrl: "https://opencode.ai/docs/cli/",
  installCommand: "curl -fsSL https://opencode.ai/install | bash",
  // 官方 Windows 段给了 choco / scoop / npm / mise / docker 五条,这里取 npm 那条:
  // 其余四条都得先装另一个包管理器,而 harness 本身就跑在 Node 上,npm 一定在。
  installCommandWindows: "npm install -g opencode-ai",
  // 官方安装页在 Windows 段挂了一条 "Recommended: Use WSL" 的提示 —— 原生能装,
  // 但他们自己更推荐 WSL,如实转述,别替官方打包票。
  windowsNote: "原生可装,但官方安装页仍建议在 WSL 里用。",
  untested: true,
  notes:
    "依据(2026-07-30 查阅 opencode.ai/docs/cli 与 GitHub dev 分支 packages/opencode/src/cli/cmd/run.ts," +
    "仓库现在在 anomalyco/opencode,旧地址 sst/opencode):" +
    "①`opencode run [message..]` 是非交互一次性执行,prompt 走位置参数(源码里没有 stdin 通道," +
    "缺 message 直接 exit 1),所以大 prompt 受 argv 长度上限约束;" +
    "②`--auto` 才自动批准权限 —— 源码的 permission.asked 分支在没有 --auto 时打印警告并 reject," +
    "也就是说不给这个 flag 不会卡住、而是工具全被拒(任务看着跑完却什么都没改);" +
    "③`--format json` 输出 JSONL,但 schema 与 claude 的 stream-json 完全不同" +
    "(每行 `{type,timestamp,sessionID,part|error}`,type ∈ text/reasoning/tool_use/step_start/step_finish/error)," +
    "所以内联了自己的 parser,不能用 claudeStreamJsonParser;`--thinking` 是 reasoning 事件的开关;" +
    "④模型是 `provider/model`(id 取自 models.dev),`--variant` 才是思考强度,档位由 provider 决定" +
    "(anthropic 只有 high/max,google 只有 low/high,openai 大致 minimal→xhigh),不合法组合由 CLI/上游拒绝;" +
    "⑤sessionID 由 CLI 产生(`ses_…`),靠 parser 发 {kind:\"session\"} 带回来,再用 `--session <id>` 续跑。" +
    "仍未确认的点:①`run` 的隐藏 flag `--replay`(默认 true)在 `--session` 续跑时会不会把旧消息重播成 text 事件" +
    "—— 会的话续跑回合的时间线要重复一遍历史,`--no-replay` 能治但它是隐藏 flag、装机版本未必有,所以没写进 baseArgs;" +
    "②上游 issue #26855(json 模式可能在收到 session.status=idle 后提前退出、漏掉最后的 step_finish)" +
    "对本 parser 无影响(不依赖 step_finish 收口),但会让 token/费用统计缺失;" +
    "③relay 故意没写:opencode 的自定义 provider 只能配在 opencode.json 的 provider.*.options.baseURL 里," +
    "没有「一个环境变量改 base url」的通道,拿半截配置去撞端点不如让它用自己的账号。",
  exec: {
    subcommand: ["run"],
    // --auto:自动批准未被显式拒绝的权限(不给它 = 工具调用全被 reject)。
    // --format json:JSONL 事件流,给下面的 parser 用。--thinking:开 reasoning 事件。
    baseArgs: ["--auto", "--format", "json", "--thinking"],
    prompt: { via: "arg" },
    model: { flag: "--model" },
    // opencode 把「思考强度」叫 variant(provider-specific reasoning effort)。
    reasoningEffort: { flag: "--variant" },
    // id 由 CLI 自己产生(ses_…),parser 负责发 {kind:"session"} 带回来;
    // 交互式恢复走 tui 的 --session(run 与 tui 都认这个 flag)。
    session: {
      resumeArgs: (id) => ["--session", id],
      interactive: (id) => `opencode --session ${id}`,
    },
    parser: (ctx) => opencodeEvents(ctx),
  },
};

/**
 * `opencode run --format json` 的 JSONL 解析。
 *
 * 每行一个事件:`{ type, timestamp, sessionID, ... }`,五种 type(源码 run.ts 的 emit 分支):
 *   text        part.text —— 已完成的整块正文(gate 是 part.time.end,所以不是增量)
 *   reasoning   part.text —— 思考块,只在带 --thinking 时发
 *   tool_use    part.tool / part.state.{status,title,input} —— 只在工具跑完(completed/error)时发
 *   step_start / step_finish  步骤边界(含 cost/tokens),这里不需要
 *   error       error.name + error.data.message —— 会话级失败,进程也会 exit 1
 *
 * 解析不出 JSON 的行**退回当正文**:装机版本万一不认 `--format json`(或往 stdout 打了
 * 别的东西),这样至少还等于 textParser,而不是一行都看不见。
 */
const opencodeEvents: CliParser = async function* (ctx: CliParserContext): AsyncIterable<AgentEvent> {
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
        const msg = errorMessage(ev.error);
        sawError = true;
        if (!lifecycle.stopRequested) push({ kind: "error", message: msg });
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
      // 已经从 error 事件报过一次的就不再重复(opencode 有会话级错误时自己会 exit 1)。
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
          `(执行参数在 server/src/executors/catalog/opencode.ts${tail ? `;stderr:${tail.slice(0, 500)}` : ""})`,
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

// error 事件没有 part,形状是 { name, data?: { message? } }。
function errorMessage(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "opencode 报告了一个未知错误";
  const err = raw as Record<string, unknown>;
  const name = typeof err.name === "string" ? err.name : "";
  const data = (err.data ?? {}) as Record<string, unknown>;
  const msg = typeof data.message === "string" ? data.message : "";
  return [name, msg].filter(Boolean).join("：") || "opencode 报告了一个未知错误";
}

const clip = (s: string) => (s.length <= 200 ? s : s.slice(0, 200) + "…");
