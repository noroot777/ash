import { createInterface } from "node:readline";
import type { AgentEvent } from "@harness/shared";
import { RunTraceRecorder } from "../diagnostics.js";
import { forceFinishOnExit, spawnErrorMessage } from "../spawn.js";
import type { CliParser, CliParserContext, CliSpec } from "./types.js";

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分按 2026-07-30 官方文档校准,
// **本机未装 Cursor CLI、未实测**,所以 untested 保留。
export const cursorSpec: CliSpec = {
  key: "cursor",
  name: "Cursor CLI",
  description: "Cursor 终端智能体",
  // 官方现在叫 `agent`,`cursor-agent` 是保留的兼容别名。这里先探别名:
  // `agent` 太通用,得靠 fallbackVersionMatch 自证是 Cursor 才算数。
  bins: ["cursor-agent", "agent"],
  fallbackVersionMatch: "cursor",
  docsUrl: "https://cursor.com/docs/cli/installation",
  installCommand: "curl https://cursor.com/install -fsS | bash",
  untested: true,
  notes:
    "依据 2026-07-30 查阅 cursor.com/docs/cli/{using,headless,reference/parameters,reference/output-format," +
    "reference/authentication,reference/configuration,reference/permissions} 与 docs/models-and-pricing.md;本机未装 Cursor CLI,没有实跑过。" +
    "已核准:①非交互用 `-p/--print` + prompt 位置参数,官方 headless 示例是 `agent -p --force \"<prompt>\"`;" +
    "②自动批准用 `--force`/`--yolo`,不给则文件修改只提案不落盘、命令会等审批;③`--trust` 只在 headless mode 有效," +
    "`--approve-mcps` 自动批准 MCP,两者都带上以免无人值守卡确认;④`--output-format stream-json --stream-partial-output`" +
    "是 Cursor 自己的 NDJSON schema(type=system/user/assistant/tool_call/result),不同于 claude 的 stream-json," +
    "所以内联 parser;⑤`--resume [chatId]` 可恢复已有 thread,session_id 由 CLI 生成并在 stream-json 事件里返回;" +
    "⑥`--model <model>` 存在,但官方建议用 `agent models` 看账号可用模型;shared 里的 preset 是按官方模型页名称归一出的常用候选," +
    "未逐一验证为 CLI 接受的精确 id;⑦官方认证通道是浏览器登录或 `CURSOR_API_KEY`/`--api-key`。" +
    "仍未确认:①`--resume <uuid>` 与 `-p` 同时给时是否一定在无头模式续上历史;②官方未列单独 reasoning-effort flag," +
    "Grok 4.5 的 effort/Fast mode 看起来通过模型选择或账号计划控制,因此不写 reasoningEffort/fastArgs;" +
    "③第三方 key/base-url 通道未确认,不写 relay,避免把 OpenAI 形状供应商硬接到 Cursor 官方账号体系。",
  exec: {
    baseArgs: ["-p", "--force", "--trust", "--approve-mcps", "--output-format", "stream-json", "--stream-partial-output"],
    prompt: { via: "arg" },
    model: { flag: "--model" },
    session: {
      resumeArgs: (id) => ["--resume", id],
      // 展示给用户复制的命令固定用兼容别名 `cursor-agent`:官方主名 `agent` 太通用,
      // 本机实测 `which agent` 命中的是 grok,照抄主名会让用户把 Cursor 会话喂给别家 CLI。
      // (派任务侧不受影响 —— 那边走 execBinFor 探到的真实 bin。)
      interactive: (id) => `cursor-agent --resume ${id}`,
    },
    parser: (ctx) => cursorStreamJsonParser(ctx),
  },
};

interface CursorStreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content?: Array<{ type?: string; text?: string }>;
  };
  timestamp_ms?: number;
  model_call_id?: string;
  call_id?: string;
  tool_call?: unknown;
  result?: string;
  is_error?: boolean;
}

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[@-Z\\-_]/g;
const stripAnsi = (s: string) => s.replace(ANSI, "");
const MAX_DETAIL = 300;

// Cursor 的 stream-json 不是 claude schema:
// - session 在各事件的 session_id 字段;
// - assistant 文本在 message.content[].text;
// - 工具事件是 type=tool_call + subtype=started/completed + *ToolCall 对象。
// 因此不能复用 claudeStreamJsonParser。
const cursorStreamJsonParser: CliParser = async function* (ctx: CliParserContext): AsyncIterable<AgentEvent> {
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
  const toolNames = new Map<string, string>();
  let textChunks = 0;
  let stdoutLines = 0;
  let stderrTail = "";
  let strayTail = "";
  let sessionSent = false;
  let sawResult = false;

  const sendSession = (id: unknown) => {
    if (sessionSent || typeof id !== "string" || !id) return;
    sessionSent = true;
    push({ kind: "session", cliSessionId: id });
  };

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (raw) => {
    const line = raw.trim();
    if (!line) return;
    stdoutLines += 1;
    trace.event(line);

    let ev: CursorStreamEvent;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) throw new Error("not an object");
      ev = parsed as CursorStreamEvent;
    } catch {
      strayTail = (strayTail + stripAnsi(raw) + "\n").slice(-2000);
      return;
    }

    sendSession(ev.session_id);
    switch (ev.type) {
      case "assistant": {
        const text = messageText(ev.message);
        if (!text) break;
        // With --stream-partial-output Cursor sends:
        // 1. timestamp_ms present, no model_call_id: true delta;
        // 2. timestamp_ms + model_call_id: duplicate buffered flush;
        // 3. neither field: duplicate final flush.
        if ("timestamp_ms" in ev) {
          if (!("model_call_id" in ev)) {
            textChunks += 1;
            push({ kind: "text", text });
          }
        }
        break;
      }
      case "tool_call":
        handleToolEvent(ev, toolNames, push);
        break;
      case "result":
        sawResult = true;
        if (ev.subtype && ev.subtype !== "success" && !lifecycle.stopRequested)
          push({ kind: "error", message: `result: ${ev.subtype}` });
        else if (ev.is_error && !lifecycle.stopRequested)
          push({ kind: "error", message: typeof ev.result === "string" ? ev.result.slice(0, 2000) : "Cursor CLI 回合失败" });
        else if (textChunks === 0 && typeof ev.result === "string" && ev.result) {
          textChunks += 1;
          push({ kind: "text", text: ev.result.endsWith("\n") ? ev.result : `${ev.result}\n` });
        }
        break;
      default:
        break;
    }
  });
  child.stderr?.on("data", (d) => {
    const chunk = String(d);
    stderrTail = (stderrTail + chunk).slice(-8000);
    trace.stderr(chunk);
  });

  const finish = (opts: { exitStatus: number; spawnError?: string; flushTimeout?: boolean }) => {
    if (finished) return;
    finished = true;
    trace.close();
    const tail = stripAnsi(stderrTail).trim() || stripAnsi(strayTail).trim();
    if (opts.spawnError) push({ kind: "error", message: opts.spawnError });
    else if (opts.flushTimeout)
      push({ kind: "error", message: "进程已退出但输出流未正常收尾(疑有残留子进程占用管道),已强制结束本回合" });
    else if (!lifecycle.stopRequested && opts.exitStatus !== 0)
      push({
        kind: "error",
        message: tail
          ? `${label} 以 exit ${opts.exitStatus} 结束：${tail.slice(0, 2000)}`
          : `${label} 以 exit ${opts.exitStatus} 结束,且 stderr 为空(命令行参数可能不对)`,
      });
    else if (!lifecycle.stopRequested && opts.exitStatus === 0 && !sawResult && textChunks === 0)
      push({
        kind: "error",
        message:
          `${label} 以 exit 0 结束但没有任何 Cursor stream-json 结果 —— 多半是非交互参数不对` +
          `(执行参数在 server/src/executors/catalog/cursor.ts${tail ? `;输出尾巴:${tail.slice(0, 500)}` : ""})`,
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

function handleToolEvent(ev: CursorStreamEvent, toolNames: Map<string, string>, push: (e: AgentEvent) => void) {
  const info = toolInfo(ev.tool_call);
  const callId = typeof ev.call_id === "string" ? ev.call_id : "";
  const name = info.name || (callId && toolNames.get(callId)) || "tool";
  if (callId && info.name) toolNames.set(callId, info.name);
  if (ev.subtype === "started") push({ kind: "tool", name, detail: info.detail });
  else if (ev.subtype === "completed" && info.failed) push({ kind: "tool", name, detail: `失败：${info.detail ?? ""}`.trim() });
}

function messageText(message: CursorStreamEvent["message"]): string {
  return (
    message?.content
      ?.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join("") ?? ""
  );
}

function toolInfo(toolCall: unknown): { name?: string; detail?: string; failed?: boolean } {
  if (!isRecord(toolCall)) return {};
  const fn = toolCall.function;
  if (isRecord(fn)) {
    return { name: typeof fn.name === "string" ? fn.name : "tool", detail: clip(String(fn.arguments ?? "")) || undefined };
  }
  for (const [key, value] of Object.entries(toolCall)) {
    if (!key.endsWith("ToolCall") || !isRecord(value)) continue;
    const name = key.slice(0, -"ToolCall".length) || "tool";
    const args = isRecord(value.args) ? value.args : undefined;
    const result = isRecord(value.result) ? value.result : undefined;
    const failed = !!result && !("success" in result);
    return { name, detail: summarize(args ?? result), failed };
  }
  return {};
}

function summarize(value: unknown): string | undefined {
  if (typeof value === "string") return clip(value);
  if (!isRecord(value)) return undefined;
  for (const k of ["path", "command", "url", "pattern", "description"]) {
    const v = value[k];
    if (typeof v === "string" && v) return clip(v);
  }
  try {
    return clip(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function clip(s: string): string {
  return s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL)}...` : s;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
