import { createInterface } from "node:readline";
import type { AgentEvent } from "@harness/shared";
import { RunTraceRecorder } from "../diagnostics.js";
import { forceFinishOnExit, spawnErrorMessage } from "../spawn.js";
import type { CliParser, CliSpec } from "./types.js";

interface GrokStreamEvent {
  type?: string;
  data?: unknown;
  message?: string;
  sessionId?: string;
}

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[@-Z\\-_]/g;
const stripAnsi = (s: string) => s.replace(ANSI, "");

// v0.2.114 的 streaming-json 是 Grok 自己的 NDJSON schema:thought/text 的 data
// 是 token 增量,end 才带 sessionId。真实文件写入没有输出 tool-call 事件。
const grokStreamingJsonParser: CliParser = async function* (ctx) {
  const { child, bin, label, lifecycle } = ctx;
  const queue: AgentEvent[] = [];
  let resolve: (() => void) | null = null;
  let finished = false;
  const push = (event: AgentEvent) => {
    queue.push(event);
    resolve?.();
    resolve = null;
  };

  const trace = new RunTraceRecorder(ctx.trace);
  let jsonLines = 0;
  let sawEnd = false;
  let sessionSent = false;
  let structuredError = "";
  let strayTail = "";
  let stderrTail = "";

  const sendSession = (id: unknown) => {
    if (sessionSent || typeof id !== "string" || !id) return;
    sessionSent = true;
    push({ kind: "session", cliSessionId: id });
  };

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (raw) => {
    const line = raw.trim();
    if (!line) return;
    trace.event(line);

    let event: GrokStreamEvent;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      event = parsed as GrokStreamEvent;
    } catch {
      strayTail = (strayTail + stripAnsi(raw) + "\n").slice(-2000);
      return;
    }
    jsonLines += 1;

    switch (event.type) {
      case "thought":
        if (typeof event.data === "string" && event.data)
          push({ kind: "thinking", text: event.data });
        break;
      case "text":
        if (typeof event.data === "string" && event.data) push({ kind: "text", text: event.data });
        break;
      case "end":
        sawEnd = true;
        sendSession(event.sessionId);
        break;
      case "error":
        if (typeof event.message === "string" && event.message) {
          structuredError = event.message;
          if (!lifecycle.stopRequested) push({ kind: "error", message: `${label}：${event.message}` });
        }
        break;
      default:
        break;
    }
  });
  child.stderr?.on("data", (data) => {
    const chunk = String(data);
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
    else if (!lifecycle.stopRequested && opts.exitStatus !== 0 && !structuredError)
      push({
        kind: "error",
        message: `${label} 以 exit ${opts.exitStatus} 结束${tail ? `：${tail.slice(0, 2000)}` : ",且 stderr 为空"}`,
      });
    else if (!lifecycle.stopRequested && opts.exitStatus === 0 && !sawEnd)
      push({
        kind: "error",
        message:
          `${label} 以 exit 0 结束但没有 streaming-json 的 end 事件` +
          `${jsonLines === 0 ? "(输出格式参数可能未生效)" : ""}${tail ? `;输出尾巴:${tail.slice(0, 500)}` : ""}`,
      });
    push({ kind: "done", exitStatus: opts.exitStatus });
    resolve?.();
    resolve = null;
  };

  child.on("error", (error: NodeJS.ErrnoException) =>
    finish({ exitStatus: 1, spawnError: spawnErrorMessage(bin, error) }),
  );
  child.on("close", (code, signal) => finish({ exitStatus: code ?? (signal ? 1 : 0) }));
  forceFinishOnExit(child, () => finished, (exit) => finish({ exitStatus: exit, flushTimeout: true }));

  while (true) {
    if (queue.length) {
      yield queue.shift()!;
      continue;
    }
    if (finished) return;
    await new Promise<void>((resume) => (resolve = resume));
  }
};

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。
export const grokSpec: CliSpec = {
  key: "grok",
  name: "Grok Build",
  description: "xAI 编码 CLI",
  bins: ["grok"],
  docsUrl: "https://docs.x.ai/build/overview",
  installCommand: "curl -fsSL https://x.ai/cli/install.sh | bash",
  notes:
    "实测于 2026-07-30,版本 grok 0.2.114 (0c785038798)。" +
    "已确认 -p + --always-approve + --permission-mode bypassPermissions 可无交互写入文件;" +
    "streaming-json 按 token 输出 thought/text,end 带 sessionId,真实文件写入未输出工具调用事件,故内联 parser 只解析思考、正文、session 与错误。" +
    "显式 --session-id 新建会话后用 --resume 可无头续跑并准确记住上回合内容;登录态 grok models 仅列出 grok-4.5。" +
    "已实跑 --model grok-4.5 + --reasoning-effort low;成功事件的内部 modelUsage 名为 grok-4.5-build。" +
    "未接 relay:根命令 grok -p 不接受 --xai-api-base-url,仅支持 XAI_API_KEY 认证提示;" +
    "agent 子命令虽有 base-url/stdio/headless,但不是单回合 prompt 通道。",
  exec: {
    baseArgs: [
      "--always-approve",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "streaming-json",
    ],
    prompt: { via: "flag", flag: "-p" },
    model: { flag: "--model" },
    reasoningEffort: { flag: "--reasoning-effort" },
    session: {
      newIdFlag: "--session-id",
      resumeArgs: (id) => ["--resume", id],
      interactive: (id) => `grok --resume ${id}`,
    },
    parser: grokStreamingJsonParser,
  },
};
