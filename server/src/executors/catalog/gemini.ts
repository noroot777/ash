import { createInterface } from "node:readline";
import type { AgentEvent } from "@harness/shared";
import { RunTraceRecorder } from "../diagnostics.js";
import { forceFinishOnExit, spawnErrorMessage } from "../spawn.js";
import type { CliParser, CliSpec } from "./types.js";

// ── gemini 的 stream-json 事件 ─────────────────────────────────────────────
// schema 来自 v0.53.0 的 packages/core/src/output/types.ts(JsonStreamEvent):
// 平铺字段 + snake_case,**跟 claude 的 stream-json 不是一套**(没有
// message.content[] 数组、session_id 只在 init 里出现),所以不能复用
// claudeStreamJsonParser —— 那份套上来会一行都解析不出,比 textParser 还差。
interface GeminiStreamEvent {
  type?: string;
  session_id?: string;
  role?: string;
  content?: string;
  tool_name?: string;
  tool_id?: string;
  parameters?: unknown;
  status?: string;
  severity?: string;
  message?: string;
  output?: string;
  error?: { type?: string; message?: string };
}

// 官方文档(docs/cli/headless.md)列的退出码,报错时顺带翻译一下,免得用户
// 拿着一个裸数字去搜。
const EXIT_HINT: Record<number, string> = {
  1: "通用错误或 API 调用失败",
  42: "输入/参数错误",
  53: "超出单会话回合上限(maxSessionTurns)",
};

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[@-Z\\-_]/g;
const stripAnsi = (s: string) => s.replace(ANSI, "");

const MAX_DETAIL = 300;
const detailOf = (params: unknown): string | undefined => {
  if (params === undefined || params === null) return undefined;
  let s: string;
  try {
    s = JSON.stringify(params) ?? "";
  } catch {
    return undefined;
  }
  if (!s || s === "{}") return undefined;
  return s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL)}…` : s;
};

// 惰性 async generator:所有 child.on(...) 都在函数体里注册,第一次迭代才跑。
// 预检失败时 spawnAgent 给的是「有人监听才报错」的假 child,抢跑的 'error'
// 会变成 uncaughtException,任务永远卡 running(见 server/CLAUDE.md)。
const geminiStreamJsonParser: CliParser = async function* (ctx) {
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
  const toolNames = new Map<string, string>(); // tool_id → tool_name(tool_result 只带 id)
  let textChunks = 0;
  let strayTail = ""; // 解析不了的行(升级提示之类),只在兜底报错时用得上
  let stderrTail = "";

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (raw) => {
    const line = raw.trim();
    if (!line) return;
    trace.event(line);
    let ev: GeminiStreamEvent;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      ev = parsed as GeminiStreamEvent;
    } catch {
      // 一行脏数据不许炸掉整个回合;留个尾巴给收尾时的诊断文案。
      strayTail = (strayTail + stripAnsi(raw) + "\n").slice(-2000);
      return;
    }
    switch (ev.type) {
      case "init":
        // sessionId 由 gemini 自己产生,只能从这里带回来(spec 的 session 走 (c) 档)。
        if (ev.session_id) push({ kind: "session", cliSessionId: ev.session_id });
        break;
      case "message":
        // role:"user" 是 CLI 把我们刚发过去的 prompt 原样回显一遍,写进时间线
        // 等于把任务正文抄一份进会话记录。
        if (ev.role === "assistant" && ev.content) {
          textChunks += 1;
          push({ kind: "text", text: ev.content });
        }
        break;
      case "tool_use": {
        const name = ev.tool_name || "tool";
        if (ev.tool_id) toolNames.set(ev.tool_id, name);
        push({ kind: "tool", name, detail: detailOf(ev.parameters) });
        break;
      }
      case "tool_result":
        // 成功的工具结果不再单独占一行(tool_use 已经记过这次调用),只报失败。
        if (ev.status === "error") {
          const name = (ev.tool_id && toolNames.get(ev.tool_id)) || "tool";
          const why = ev.error?.message ?? ev.output ?? "(CLI 未给出原因)";
          push({ kind: "tool", name, detail: `失败：${why}`.slice(0, MAX_DETAIL) });
        }
        break;
      case "error":
        // 手停(kill)不算故障,别往时间线塞错误。
        if (!lifecycle.stopRequested && ev.message)
          push({
            kind: "error",
            message: ev.severity === "warning" ? `${label} 警告：${ev.message}` : `${label}：${ev.message}`,
          });
        break;
      case "result":
        if (ev.status === "error" && !lifecycle.stopRequested)
          push({ kind: "error", message: `${label} 回合失败：${ev.error?.message ?? "(CLI 未给出原因)"}` });
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

  // 收尾单点:三条路(spawn 失败 / close / exit 后流不收尾)都汇到这里,
  // 保证事件流一定以 done 结束 —— 少一个 done 就是任务永远卡 running。
  const finish = (o: { exitStatus: number; spawnError?: string; flushTimeout?: boolean }) => {
    if (finished) return;
    finished = true;
    trace.close();
    const tail = stripAnsi(stderrTail).trim() || stripAnsi(strayTail).trim();
    if (o.spawnError) push({ kind: "error", message: o.spawnError });
    else if (o.flushTimeout)
      push({ kind: "error", message: "进程已退出但输出流未正常收尾(疑有残留子进程占用管道),已强制结束本回合" });
    else if (!lifecycle.stopRequested && o.exitStatus !== 0) {
      const hint = EXIT_HINT[o.exitStatus] ? `(${EXIT_HINT[o.exitStatus]})` : "";
      push({
        kind: "error",
        message: `${label} 以 exit ${o.exitStatus} 结束${hint}${tail ? `：${tail.slice(0, 2000)}` : ",且 stderr 为空(命令行参数可能不对)"}`,
      });
    } else if (!lifecycle.stopRequested && o.exitStatus === 0 && textChunks === 0)
      push({
        kind: "error",
        message:
          `${label} 以 exit 0 结束但没有任何 assistant 输出 —— 多半是 --output-format stream-json 没生效` +
          `(执行参数在 server/src/executors/catalog/gemini.ts)${tail ? `;输出尾巴:${tail.slice(0, 500)}` : ""}`,
      });
    push({ kind: "done", exitStatus: o.exitStatus });
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
    await new Promise<void>((r) => (resolve = r));
  }
};

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分按 v0.53.0 官方文档 + 源码
// 核准,**本机没装 gemini、未实测**,所以 untested 保留(见 notes)。
export const geminiSpec: CliSpec = {
  key: "gemini",
  name: "Gemini CLI",
  description: "Google 官方 CLI",
  bins: ["gemini"],
  docsUrl: "https://github.com/google-gemini/gemini-cli",
  installCommand: "npm install -g @google/gemini-cli",
  untested: true,
  notes:
    "按 v0.53.0(2026-07-28 发版)核准于 2026-07-30,依据 docs/cli/{cli-reference,headless,session-management}.md " +
    "与源码 packages/cli/src/config/config.ts、packages/core/src/output/types.ts;本机未装 gemini,**没有实跑过**。" +
    "已核准:①`-p/--prompt` 是「强制非交互」的一次性执行(非 TTY 也会自动进 headless);" +
    "②自动批准用 `--approval-mode yolo`(`--yolo` 已标 Deprecated,且与 --approval-mode 同时给会被拒);" +
    "③`--output-format stream-json` 的 JSONL schema 是 init/message/tool_use/tool_result/error/result 平铺字段," +
    "与 claude 不同,故内联了自己的 parser;④`--model` 别名 auto/pro/flash/flash-lite;" +
    "⑤会话 id 由 CLI 生成、只在 init 事件里,续跑用 `--resume <uuid>`;" +
    "⑥`--skip-trust` 会置 GEMINI_CLI_TRUST_WORKSPACE=true —— 必须带,因为 harness 跑在用户从没交互式信任过的仓库/worktree 里," +
    "不带就落进「受限安全模式」,表现为 agent 静默失去改文件的能力(注意官方文档自相矛盾:" +
    "docs/cli/trusted-folders.md 说该特性默认关,而 settings 参考与源码 `?? true` 说默认开,这里按最坏情况处理)。" +
    "仍未确认(要装了 CLI 才能定):㈠assistant 文本是否只走 delta 分片、会不会另发一份完整消息导致正文翻倍;" +
    "㈡`--resume <uuid>` 与 `-p` 同时给时是否真的既续上历史又保持非交互;" +
    "㈢老版本没有 `--skip-trust`/`--approval-mode` 时会 exit 1 + 打 help(响亮失败,不是静默降级);" +
    "㈣未接 relay:gemini 的第三方通道是 GOOGLE_GEMINI_BASE_URL + GEMINI_API_KEY,但它要求对端讲 Google GenAI 协议" +
    "(/v1beta/...:generateContent),而 harness 的 llm_providers 是 OpenAI 形状的 /v1,硬接必然 404,所以刻意不写 relay。",
  exec: {
    // --approval-mode yolo:自动批准所有工具调用(不给就会停在交互确认,任务永不结束)。
    // --skip-trust:见 notes ⑥。--output-format stream-json:换来工具调用与 sessionId。
    baseArgs: ["--approval-mode", "yolo", "--skip-trust", "--output-format", "stream-json"],
    // 走 -p 而不是 stdin:文档明说 -p「Forces non-interactive mode」,是唯一有书面保证
    // 的非交互开关;stdin 也能喂(`cat x | gemini`),但那条路靠的是「非 TTY 自动 headless」
    // 的推断,赌错的代价是任务永远卡住。代价:超大 prompt 受 argv 长度上限约束。
    prompt: { via: "flag", flag: "-p" },
    model: { flag: "--model" },
    // 没有 reasoning effort 概念:思考预算只能写 settings.json 的
    // generationConfig.thinkingConfig.thinkingBudget,没有对应的命令行 flag。
    // 也没有 1.5x 加速档,故不设 fastArgs。
    session: {
      // (c) 档:id 由 gemini 自己产生,靠上面 parser 从 init 事件带回来,
      // harness 不发 id(gemini 的 --session-id 只在源码里注册、未进官方 cheatsheet,
      // 少赌一个 flag)。--resume 接受 latest / 序号 / 完整 uuid,这里只用 uuid。
      resumeArgs: (id) => ["--resume", id],
      interactive: (id) => `gemini --resume ${id}`,
    },
    parser: geminiStreamJsonParser,
  },
};
