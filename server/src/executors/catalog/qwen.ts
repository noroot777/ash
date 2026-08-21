import { createInterface } from "node:readline";
import type { AgentEvent } from "@ash/shared";
import { RunTraceRecorder } from "../diagnostics.js";
import { forceFinishOnExit, spawnErrorMessage } from "../spawn.js";
import { relayApi } from "../../llm.js";
import type { CliParser, CliParserContext, CliSpec } from "./types.js";

// ── Qwen Code 的 stream-json 解析 ───────────────────────────────────────────
// 官方文档(Headless Mode)给的对象形状与 claude 的 stream-json **同源**(它是
// gemini-cli 的 fork,但输出格式抄的是 claude Code 的那套):
//   {"type":"system","subtype":"session_start","session_id":…,"model":…}
//   {"type":"assistant","session_id":…,"message":{"content":[{type:"text"|"thinking"|"tool_use",…}]}}
//   {"type":"user","session_id":…,"message":{"content":[{type:"tool_result","is_error":…}]}}
//   {"type":"result","subtype":"success","session_id":…,"is_error":…,"result":…,"usage":…}
//
// 那为什么不直接复用 claudeStreamJsonParser?两处对不上,照抄会丢正文:
//   ① claude 那份**只认 `--include-partial-messages` 的增量**(完整 assistant 消息
//      里的 text 被当成「增量已经播过」而刻意不再 push)。qwen 文档只说开了这个
//      flag 会多出 message_start / content_block_delta,**没说它们外面是不是还包一层
//      `{"type":"stream_event"}`** —— 包法不一致就一个字都出不来,比 textParser 还差。
//   ② qwen 的 system 子类型是 `session_start` 而不是 claude 的 `init`。
// 所以这份自己收口:增量**两种包法都认**,并且只有「本条消息确实没播过增量」时才
// 从完整消息里补正文 —— 无论 qwen 走哪种包法,正文都恰好出现一次。
const qwenStreamJsonParser: CliParser = (ctx) => qwenEvents(ctx);

async function* qwenEvents(ctx: CliParserContext): AsyncIterable<AgentEvent> {
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
  let parsedLines = 0; // 一行都没解析出来 = 参数多半不对,退出时给个能查的提示
  let stderrTail = "";
  let sessionSent = false;
  // 本条 assistant 消息是否已经由增量播过正文。增量在前、完整消息在后,所以
  // 用一个标志即可:完整消息处理完就清掉,下一条消息重新判定。
  let streamedText = false;
  let textBuf = "";
  const flushText = () => {
    if (!textBuf) return;
    push({ kind: "text", text: textBuf });
    textBuf = "";
  };
  const sendSession = (id: unknown) => {
    if (sessionSent || typeof id !== "string" || !id) return;
    sessionSent = true;
    push({ kind: "session", cliSessionId: id });
  };

  // 增量:claude 那套是 {"type":"stream_event","event":{…}},也可能是裸的
  // {"type":"content_block_delta",…} —— 两种都收。
  const onDelta = (se: any) => {
    if (se?.type !== "content_block_delta") return;
    const d = se.delta;
    if (d?.type === "text_delta" && typeof d.text === "string" && d.text) {
      textBuf += d.text;
      streamedText = true;
      // 攒到一行或 ~40 字再发,免得每个 token 触发一次前端重渲染。
      if (textBuf.length >= 40 || textBuf.includes("\n")) flushText();
    } else if (d?.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
      push({ kind: "thinking", text: d.thinking });
    }
  };

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    trace.event(t);
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      return; // 一行脏数据不该炸掉整个回合
    }
    parsedLines += 1;
    sendSession(ev.session_id);
    if (ev.type === "stream_event") {
      onDelta(ev.event);
      return;
    }
    if (ev.type === "content_block_delta" || ev.type === "message_start" || ev.type === "message_stop") {
      onDelta(ev);
      return;
    }
    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      flushText();
      let hadText = false;
      for (const block of ev.message.content) {
        if (block?.type === "text") {
          hadText = true;
          // 增量播过就不重复;没播过(没开/不认增量)这里就是正文的唯一来源。
          if (!streamedText && typeof block.text === "string" && block.text) push({ kind: "text", text: block.text });
        } else if (block?.type === "thinking") {
          if (typeof block.thinking === "string" && block.thinking) push({ kind: "thinking", text: block.thinking });
        } else if (block?.type === "tool_use") {
          push({ kind: "tool", name: String(block.name ?? "tool"), detail: shortJson(block.input) });
        }
      }
      if (hadText) push({ kind: "text", text: "\n\n" }); // 段落分隔,实时与刷新后一致
      streamedText = false;
      return;
    }
    if (ev.type === "result") {
      flushText();
      // 手停时 CLI 也可能补一条失败的 result,那不是故障。
      const failed = ev.is_error === true || (ev.subtype && ev.subtype !== "success");
      if (failed && !lifecycle.stopRequested) {
        push({ kind: "error", message: `result: ${ev.subtype ?? "error"}${typeof ev.result === "string" ? `：${ev.result.slice(0, 500)}` : ""}` });
      }
    }
  });

  child.stderr?.on("data", (d) => {
    const chunk = d.toString();
    stderrTail = (stderrTail + chunk).slice(-8000);
    trace.stderr(chunk);
  });

  // 收尾单点:spawn 失败 / close / exit 后流不收尾,三条路都汇到这里 ——
  // 事件流少一个 done 就是任务永远卡 running。
  const finish = (opts: { exitStatus: number; spawnError?: string; flushTimeout?: boolean }) => {
    if (finished) return;
    finished = true;
    flushText();
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
          `${label} 以 exit 0 结束但没有任何 stream-json 输出 —— 多半是非交互参数不对` +
          `(执行参数在 server/src/executors/catalog/qwen.ts${tail ? `;stderr:${tail.slice(0, 500)}` : ""})`,
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
    await new Promise<void>((r) => (resolve = r));
  }
}

const shortJson = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 300 ? `${s.slice(0, 300)}…` : s;
  } catch {
    return undefined;
  }
};

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分**本机未实测**(没装 CLI),
// 但已按官方仓库 main 分支的 yargs 定义逐项核对过,依据写在 notes 里。
export const qwenSpec: CliSpec = {
  key: "qwen",
  name: "Qwen Code",
  description: "通义编码 CLI",
  bins: ["qwen"],
  docsUrl: "https://github.com/QwenLM/qwen-code",
  installCommand: "npm install -g @qwen-code/qwen-code@latest",
  untested: true,
  notes:
    "2026-07-30 按官方仓库 main 的 packages/cli/src/config/config.ts(yargs 定义,比文档权威)+ " +
    "docs/users/features/headless、configuration/auth 逐项核对;**本机没装 qwen,一次都没实跑**。" +
    "已核实:①`--prompt/-p` 仍在(源码里标了 deprecated,官方推荐改用位置参数 `qwen \"<prompt>\"`," +
    "但位置参数遇到以 - 开头的正文会被当 flag,所以先留 -p;哪天它真被删了再换 stdin 管道,文档确认 `echo … | qwen` 可用);" +
    "②`--yolo/-y` = 自动批准全部工具调用,与 `--approval-mode` **互斥**(源码 .check 里显式冲突),二选一;" +
    "yolo **不会**自动开沙箱(要沙箱得另给 --sandbox),等价于 claude 的 --dangerously-skip-permissions;" +
    "③`--output-format stream-json` 的对象形状与 claude 同源(system/assistant/user/result + session_id)," +
    "但 system 的 subtype 是 session_start 而非 init,且 `--include-partial-messages` 的增量包法文档没写清," +
    "所以没复用 claudeStreamJsonParser,内联了一份两种包法都认的(见文件头注释);" +
    "④`--session-id` 收 UUID(ash 的 randomUUID 正好符合),`--resume/-r <id>` 续跑,`--continue/-c` 接最近一条;" +
    "源码 .check 里 --session-id 与 resume/continue 互斥,generic 的装配二选一正好对上;" +
    "⑤会话按项目存在 ~/.qwen/projects/<转义 cwd>/chats,所以 resume 必须在同一 cwd 下(resumeFor 会带 cd);" +
    "⑥没有任何 reasoning/thinking effort 参数,也没有 1.5x 加速档;" +
    "⑦供应商走 OpenAI 兼容协议的环境变量 OPENAI_BASE_URL / OPENAI_API_KEY(优先级:CLI flag > 环境变量 > .env > settings.json)," +
    "并显式带 `--auth-type openai`(取值来自 core 的 AuthType 枚举 USE_OPENAI='openai')顶掉本机已选的登录方式。" +
    "仍未确认(装了 CLI 后优先验这几条):①stream-json 增量到底是 {\"type\":\"stream_event\"} 包一层还是裸 content_block_delta;" +
    "②`--session-id` 建的会话能不能被 `--resume` 找回;③`--auth-type openai` 与 OPENAI_* 环境变量一起给时是否真的绕开 /auth 交互;" +
    "④OpenAI 兼容模式下不给 --model 时是否强制要 OPENAI_MODEL;⑤用户 tool_result 事件(is_error)要不要也进时间线。",
  exec: {
    // 非交互三件套:自动批准 + 结构化输出 + token 级增量(后者要求 stream-json,已满足)。
    baseArgs: ["--yolo", "--output-format", "stream-json", "--include-partial-messages"],
    prompt: { via: "flag", flag: "-p" },
    model: { flag: "--model" },
    // reasoningEffort / fastArgs:qwen 没有这两个概念,刻意不写(别硬凑)。
    session: {
      newIdFlag: "--session-id",
      resumeArgs: (id) => ["--resume", id],
      interactive: (id) => `qwen --resume ${id}`,
    },
    parser: qwenStreamJsonParser,
    // OpenAI 兼容通道。key 只走 env,绝不进 argv;base_url 过 relayApi(OpenAI 系
    // 的 base_url 惯例是带 /v1,如 …/compatible-mode/v1、https://openrouter.ai/api/v1)。
    relay: (r) => ({
      env: { OPENAI_BASE_URL: relayApi(r.baseUrl), OPENAI_API_KEY: r.apiKey },
      args: ["--auth-type", "openai"],
      envHint: `OPENAI_BASE_URL=${relayApi(r.baseUrl)} OPENAI_API_KEY=<你的key> `,
    }),
  },
};
