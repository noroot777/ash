import { createInterface } from "node:readline";
import type { AgentEvent } from "@ash/shared";
import { RunTraceRecorder } from "../diagnostics.js";
import { forceFinishOnExit, spawnErrorMessage } from "../spawn.js";
import { parseKimiModels } from "../kimi-models.js";
import type { CliParser, CliParserContext, CliSpec } from "./types.js";

// Kimi Code 的 stream-json 是 OpenAI chat message 风格,不是 Claude Code 的
// system/assistant/result 事件流。每行可能是 assistant、tool 或 meta 消息;
// thinking 按官方实现不会写入 JSONL,所以这里也没有可恢复的 thinking 事件。
const kimiStreamJsonParser: CliParser = (ctx) => kimiEvents(ctx);

async function* kimiEvents(ctx: CliParserContext): AsyncIterable<AgentEvent> {
  const { child, bin, label, lifecycle } = ctx;
  // 队列、唤醒、收尾、增量合并和**图片记账的时点**都在这条共用流水线里,见
  // ../event-queue.ts —— 十一个解析器从同一个 `ctx.events` 走,拿不到裸队列。
  const push = (event: AgentEvent) => ctx.events.push(event);

  const trace = new RunTraceRecorder(ctx.trace);
  let assistantMessages = 0;
  let reportedError = false;
  let stderrTail = "";
  let sessionSent = false;

  const sendSession = (id: unknown) => {
    if (sessionSent || typeof id !== "string" || !id) return;
    sessionSent = true;
    push({ kind: "session", cliSessionId: id });
  };

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const raw = line.trim();
    if (!raw) return;
    trace.event(raw);

    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      // 参数或版本漂移时保留 CLI 的原始提示,同时让退出诊断指出没有结构化事件。
      push({ kind: "text", text: `${line}\n` });
      return;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) return;

    if (event.type === "error") {
      if (!lifecycle.stopRequested) {
        reportedError = true;
        push({ kind: "error", message: `${label}：${String(event.message ?? event.code ?? "未知错误")}` });
      }
      return;
    }

    if (event.role === "assistant") {
      if (typeof event.content === "string" && event.content) {
        assistantMessages += 1;
        push({ kind: "text", text: `${event.content}\n\n` });
      }
      if (Array.isArray(event.tool_calls)) {
        for (const call of event.tool_calls) {
          if (typeof call?.function?.name !== "string" || !call.function.name) continue;
          assistantMessages += 1;
          push({
            kind: "tool",
            name: String(call?.function?.name ?? "tool"),
            detail: shortDetail(call?.function?.arguments),
          });
        }
      }
      return;
    }

    if (event.role === "meta" && event.type === "session.resume_hint") {
      sendSession(event.session_id);
    }
    // role=tool 是刚才工具调用的结果,不重复塞进 assistant 正文。
  });

  child.stderr?.on("data", (data) => {
    const chunk = data.toString();
    stderrTail = (stderrTail + chunk).slice(-8000);
    trace.stderr(chunk);
  });

  const finish = (opts: { exitStatus: number; spawnError?: string; flushTimeout?: boolean }) => {
    if (ctx.events.closed) return;
    trace.close();
    const tail = stderrTail.trim();
    if (opts.spawnError) push({ kind: "error", message: opts.spawnError });
    else if (opts.flushTimeout)
      push({ kind: "error", message: "进程已退出但输出流未正常收尾(疑有残留子进程占用管道),已强制结束本回合" });
    else if (!lifecycle.stopRequested && !reportedError && opts.exitStatus !== 0)
      push({
        kind: "error",
        message: tail
          ? `${label} 以 exit ${opts.exitStatus} 结束：${tail.slice(0, 2000)}`
          : `${label} 以 exit ${opts.exitStatus} 结束,且 stderr 为空(命令行参数可能不对)`,
      });
    else if (!lifecycle.stopRequested && !reportedError && opts.exitStatus === 0 && assistantMessages === 0)
      push({
        kind: "error",
        message:
          `${label} 以 exit 0 结束但没有有效的 assistant 输出（只有元数据或输出格式已变化）` +
          `(执行参数在 server/src/executors/catalog/kimi.ts${tail ? `;stderr:${tail.slice(0, 500)}` : ""})`,
      });
    push({ kind: "done", exitStatus: opts.exitStatus });
    ctx.events.close();
  };

  child.on("error", (err: NodeJS.ErrnoException) => finish({ exitStatus: 1, spawnError: spawnErrorMessage(bin, err) }));
  child.on("close", (code, signal) => finish({ exitStatus: code ?? (signal ? 1 : 0) }));
  forceFinishOnExit(child, () => ctx.events.closed, (exit) => finish({ exitStatus: exit, flushTimeout: true }));

  yield* ctx.events.drain();
}

const shortDetail = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 500 ? `${text.slice(0, 500)}...` : text;
  } catch {
    return undefined;
  }
};

export const kimiSpec: CliSpec = {
  key: "kimi",
  name: "Kimi Code CLI",
  description: "月之暗面 CLI",
  bins: ["kimi"],
  docsUrl: "https://github.com/MoonshotAI/kimi-code",
  installCommand: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
  // install.ps1 文件头:「kimi-code installer for Windows (PowerShell 5.1+)」
  // (2026-08-14 拉取确认)。
  installCommandWindows: "irm https://code.kimi.com/kimi-code/install.ps1 | iex",
  // kimi-code 在 Windows 上把 Git for Windows 自带的 bash 当执行 shell 用
  // (`KIMI_SHELL_PATH` 可改指向),没装 Git 它跑不了带命令的工具调用。
  windowsNote: "需要先装 Git for Windows:它自带的 bash 是 kimi 的执行 shell(可用 KIMI_SHELL_PATH 覆盖)。",
  notes:
    "2026-10-24 使用 Kimi Code CLI 2.3.1 实测：隔离配置与本地兼容服务下的文件工具、MCP 调用、" +
    "stream-json、session.resume_hint 与跨进程 --session 续跑。kimi provider list --json 读取本机模型及档位。" +
    "智能水平通过 KIMI_MODEL_THINKING_EFFORT 注入，仅 kimi provider 支持；不提供第三方供应商覆盖。" +
    "官方账号调用返回 403（当前订阅无 Kimi Code 权限），官方云端成功回合尚未验证。" +
    "运行 npm run setup 注册用户级 ash MCP；未注册时无法调用 complete_task。",
  models: { args: ["provider", "list", "--json"], parse: parseKimiModels },
  exec: {
    // prompt 模式自身已经自动批准;--yolo/--auto 与 -p 冲突,这里只固定结构化输出。
    baseArgs: ["--output-format", "stream-json"],
    prompt: { via: "flag", flag: "-p" },
    model: { flag: "--model" },
    reasoningEffortEnv: "KIMI_MODEL_THINKING_EFFORT",
    session: {
      resumeArgs: (id) => ["--session", id],
      interactive: (id) => `kimi --session ${id}`,
    },
    parser: kimiStreamJsonParser,
  },
};
