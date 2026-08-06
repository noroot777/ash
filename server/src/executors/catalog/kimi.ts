import { createInterface } from "node:readline";
import type { AgentEvent } from "@harness/shared";
import { RunTraceRecorder } from "../diagnostics.js";
import { forceFinishOnExit, spawnErrorMessage } from "../spawn.js";
import type { CliParser, CliParserContext, CliSpec } from "./types.js";

// Kimi Code 的 stream-json 是 OpenAI chat message 风格,不是 Claude Code 的
// system/assistant/result 事件流。每行可能是 assistant、tool 或 meta 消息;
// thinking 按官方实现不会写入 JSONL,所以这里也没有可恢复的 thinking 事件。
const kimiStreamJsonParser: CliParser = (ctx) => kimiEvents(ctx);

async function* kimiEvents(ctx: CliParserContext): AsyncIterable<AgentEvent> {
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
  let parsedLines = 0;
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
    parsedLines += 1;

    if (event.role === "assistant") {
      if (typeof event.content === "string" && event.content) {
        push({ kind: "text", text: `${event.content}\n\n` });
      }
      if (Array.isArray(event.tool_calls)) {
        for (const call of event.tool_calls) {
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
    if (finished) return;
    finished = true;
    trace.close();
    const tail = stderrTail.trim();
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
    else if (!lifecycle.stopRequested && opts.exitStatus === 0 && parsedLines === 0)
      push({
        kind: "error",
        message:
          `${label} 以 exit 0 结束但没有可解析的 stream-json 输出 —— 多半是输出格式或事件 schema 已变化` +
          `(执行参数在 server/src/executors/catalog/kimi.ts${tail ? `;stderr:${tail.slice(0, 500)}` : ""})`,
      });
    push({ kind: "done", exitStatus: opts.exitStatus });
    resolve?.();
    resolve = null;
  };

  child.on("error", (err: NodeJS.ErrnoException) => finish({ exitStatus: 1, spawnError: spawnErrorMessage(bin, err) }));
  child.on("close", (code, signal) => finish({ exitStatus: code ?? (signal ? 1 : 0) }));
  forceFinishOnExit(child, () => finished, (exit) => finish({ exitStatus: exit, flushTimeout: true }));

  while (true) {
    if (queue.length) {
      yield queue.shift()!;
      continue;
    }
    if (finished) return;
    await new Promise<void>((done) => (resolve = done));
  }
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

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。旧 Python 版已经收摊;
// 此处只依据新版 MoonshotAI/kimi-code,执行部分本机未安装、未实测。
export const kimiSpec: CliSpec = {
  key: "kimi",
  name: "Kimi Code CLI",
  description: "月之暗面 CLI",
  bins: ["kimi"],
  docsUrl: "https://github.com/MoonshotAI/kimi-code",
  installCommand: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
  untested: true,
  notes:
    "2026-07-30 按官方 kimi-code 文档及 main 源码 apps/kimi-code/src/cli/{commands,options,run-prompt,prompt-render}.ts 核对;" +
    "**本机未安装 kimi,一次都没实跑**,且已排除旧 Python 版 Kimi CLI 的资料。" +
    "已核实:①`-p/--prompt` 是不启动 TUI 的单次执行;prompt 模式会强制 permission=auto," +
    "批准工具调用并对问题返回空值,所以无需批准 flag;反而 `--prompt` 与 `--yolo/--auto/--plan` 显式冲突。" +
    "②`--output-format stream-json` 仅可与 prompt 模式使用;每行是 role=assistant/tool/meta 的 OpenAI 风格消息," +
    "不是 claude stream-json,thinking 也不会写入 JSONL,因此内联专用 parser。" +
    "③`-m/--model` 接模型别名;官方默认配置列出 kimi-code/k3、kimi-code/kimi-for-coding、" +
    "kimi-code/kimi-for-coding-highspeed。Kimi API 另有 kimi-k3、kimi-k2.7-code 等原始 model id," +
    "但未把它们混进 CLI 托管服务的别名预设。" +
    "④`-S/--session <id>` 可无头续跑,隐藏别名是 `-r/--resume`;新会话产生的 id 由" +
    "meta session.resume_hint 的 session_id 回传。`-c/--continue` 也能续最近会话,但 harness 按精确 id 恢复。" +
    "⑤thinking effort 存在于 config.toml/KIMI_MODEL_THINKING_EFFORT 与 Kimi API,CLI 命令本身没有 effort flag," +
    "故不声明 reasoningEffort。第三方 provider 可走配置或 KIMI_MODEL_* 临时模型环境变量,但其模型别名与" +
    "`--model` 的组合尚未核实,按目录约定不写半确定的 relay。" +
    "仍未确认(安装后优先实测):①真实工具回合的 stream-json 顺序与 arguments 形状;" +
    "②每次新会话是否稳定发 resume_hint、其 id 能否跨进程用 `--session` 恢复;" +
    "③不同登录方式/区域下上述 kimi-code/* 别名是否都可用;④KIMI_MODEL_* 第三方通道与 -m 的覆盖优先级。",
  exec: {
    // prompt 模式自身已经自动批准;--yolo/--auto 与 -p 冲突,这里只固定结构化输出。
    baseArgs: ["--output-format", "stream-json"],
    prompt: { via: "flag", flag: "-p" },
    model: { flag: "--model" },
    session: {
      resumeArgs: (id) => ["--session", id],
      interactive: (id) => `kimi --session ${id}`,
    },
    parser: kimiStreamJsonParser,
  },
};
