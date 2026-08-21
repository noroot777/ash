import { createInterface } from "node:readline";
import type { AgentEvent } from "@ash/shared";
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
  let thoughtBuffer = "";

  // Grok 的 streaming-json 把 thought 按 token（一两个词）逐行吐出。直接逐条
  // 发布会让前端把一次思考画成几百个折叠块；这里只合并物理上连续的 thought，
  // 遇到正文/元事件/end 就收口，因此不同模型回合仍然是不同的「思考过程」。
  const flushThought = () => {
    if (!thoughtBuffer) return;
    push({ kind: "thinking", text: thoughtBuffer });
    thoughtBuffer = "";
  };

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

    if (event.type === "thought") {
      if (typeof event.data === "string" && event.data) thoughtBuffer += event.data;
      return;
    }
    flushThought();

    switch (event.type) {
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
    flushThought();
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

// `grok models` 的输出(v1.0.3 实测):
//   You are logged in with grok.com.
//   (空行)
//   Default model: grok-4.6
//   (空行)
//   Available models:
//     * grok-4.6 (default)
//     - grok-4.5
// 只认 "Available models:" 之后的条目行,免得把抬头里的 "grok.com" 当成模型名。
// 未登录时它印的是登录提示、没有这一段,于是解析出空数组 —— 上层照实降级到内置快照。
export function parseGrokModels(stdout: string): { models: string[]; defaultModel?: string | null } {
  const lines = stripAnsi(stdout).split("\n");
  const defaultModel = /^\s*Default model:\s*(\S+)/m.exec(stripAnsi(stdout))?.[1] ?? null;
  const start = lines.findIndex((line) => /^\s*Available models:/i.test(line));
  if (start < 0) return { models: [], defaultModel };
  const models: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const item = /^\s*[*\-•]\s+(\S+)/.exec(line);
    if (!item) break; // 条目段结束(后面可能还有别的抬头)
    models.push(item[1]!);
  }
  return { models, defaultModel };
}

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。
export const grokSpec: CliSpec = {
  key: "grok",
  name: "Grok Build",
  description: "xAI 编码 CLI",
  bins: ["grok"],
  docsUrl: "https://docs.x.ai/build/overview",
  installCommand: "curl -fsSL https://x.ai/cli/install.sh | bash",
  // docs.x.ai/build/overview 的 Windows 页签(2026-08-14 核对,并下到 install.ps1 确认
  // 文件头就写着「Grok CLI installer for PowerShell」)。同页还写了 Windows 上配置文件
  // 在 %USERPROFILE%\.grok\config.toml —— 官方确有原生 Windows 版,不是让人去 WSL。
  installCommandWindows: "irm https://x.ai/cli/install.ps1 | iex",
  notes:
    "实测于 2026-08-13,版本 grok 1.0.3 (1a29d5bc12d4);首轮实测是 2026-07-30 的 0.2.114,两版行为一致的部分不再重复标注。" +
    "已确认 -p + --always-approve + --permission-mode bypassPermissions 可无交互写入文件(1.0.3 复测:真的创建了文件);" +
    "streaming-json 按 token 输出 thought/text,end 带 sessionId,真实文件写入未输出工具调用事件,故内联 parser 只解析思考、正文、session 与错误。" +
    "1.0.3 新增了 available_commands 事件(每回合开头/工具集变化时各一条,内容是工具与 slash 命令全集)—— parser 的 default 分支原样忽略,不影响;" +
    "同版还多了 streaming-messages-json(Anthropic Messages 线格式),本轮没切,因为现有 parser 在 streaming-json 上实测仍然正确。" +
    "显式 --session-id 新建会话后用 --resume 可无头续跑并准确记住上回合内容;" +
    "模型清单不再写死:spec.models 会跑 `grok models` 现问(1.0.3 实测输出 grok-4.6 默认 + grok-4.5),探不到才退回内置快照。" +
    "已实跑 --model grok-4.6 + --reasoning-effort low;成功事件的内部 modelUsage 名为 grok-4.5-build(4.5 时代实测)。" +
    "未接 relay:根命令 grok -p 不接受 --xai-api-base-url,仅支持 XAI_API_KEY 认证提示;" +
    "agent 子命令虽有 base-url/stdio/headless,但不是单回合 prompt 通道。",
  // `grok models` 是纯查询(登录态下一次网络往返),不产生会话、不烧任务 token。
  models: { args: ["models"], parse: (stdout) => parseGrokModels(stdout) },
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
