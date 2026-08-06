import { createInterface } from "node:readline";
import type { AgentEvent } from "@harness/shared";
import { RunTraceRecorder } from "../diagnostics.js";
import { forceFinishOnExit, spawnErrorMessage } from "../spawn.js";
import type { CliParser, CliParserContext, CliSpec } from "./types.js";

// ── Qoder CLI 的 stream-json 解析 ───────────────────────────────────────────
// 输出形状与 claude 的 stream-json **同源**(依据不是文档 —— 官方一个字节的
// schema 都没写 —— 而是 npm 包 @qoder-ai/qodercli@1.1.8 bundle 里的 zod 定义):
//   {"type":"system","subtype":"init","qodercli_version":…,"session_id":…,"uuid":…}
//   {"type":"assistant","message":{"content":[{type:"text"|"thinking"|"tool_use",…}]},
//    "parent_tool_use_id":…,"session_id":…}
//   {"type":"stream_event","event":{…anthropic 的 content_block_delta…},"session_id":…}
//   {"type":"result","subtype":"success"|"error_during_execution"|"error_max_turns"|
//    "error_max_budget_usd","is_error":…,"result":…,"session_id":…}
//
// 那为什么不直接用 claudeStreamJsonParser?两条:
//   ① 那份**只从增量(stream_event)取正文**,完整 assistant 消息里的 text 被当成
//      「已经播过」而刻意跳过。qoder 的增量要靠 --include-partial-messages 打开,
//      而它在 bundle 里是个 hideHelp 的隐藏 flag —— 哪天它成了空转,claude 那份
//      会**一个字都不输出**(任务看着跑完、时间线全空),比 textParser 还坏。
//      这份两路都认:增量播过就不重复,没播过就从完整消息补,正文恰好出现一次。
//   ② 那份拿不到 ctx.lifecycle,手停时可能把「被杀」报成故障。
const qoderStreamJsonParser: CliParser = (ctx) => qoderEvents(ctx);

async function* qoderEvents(ctx: CliParserContext): AsyncIterable<AgentEvent> {
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
  // 本条 assistant 消息是否已由增量播过正文。增量在前、完整消息在后,所以一个
  // 标志就够:完整消息处理完就清掉,下一条重新判定。
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
    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      flushText();
      let hadText = false;
      for (const block of ev.message.content) {
        if (block?.type === "text") {
          hadText = true;
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
      // 手停时 CLI 也会补一条 error_during_execution,那不是故障。
      const failed = ev.is_error === true || (ev.subtype && ev.subtype !== "success");
      if (failed && !lifecycle.stopRequested) {
        const detail = typeof ev.result === "string" ? ev.result : Array.isArray(ev.errors) ? ev.errors.join("; ") : "";
        push({ kind: "error", message: `result: ${ev.subtype ?? "error"}${detail ? `：${detail.slice(0, 500)}` : ""}` });
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
          `(执行参数在 server/src/executors/catalog/qoder.ts${tail ? `;stderr:${tail.slice(0, 500)}` : ""})`,
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

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS(bin 名另有实证,见下)。执行部分
// **本机未实测**(没装 CLI),但已按 npm 包 1.1.8 的 bundle 逐项核对,依据在 notes。
export const qoderSpec: CliSpec = {
  key: "qoder",
  name: "Qoder CLI",
  description: "阿里编码 CLI",
  // 官网通篇不提这个词,只有 docs 的 `qodercli --version` 能作证 —— 现在还有第二个
  // 硬证据:npm 包 @qoder-ai/qodercli 的 package.json 里 bin = {"qodercli": …}。
  bins: ["qodercli"],
  docsUrl: "https://docs.qoder.com/en/cli/quick-start",
  // 换成 npm(官方 README 的原文,且 bin 名就是它注册的);原来那条 curl 安装脚本
  // 没有任何官方页面能作证。
  installCommand: "npm install -g @qoder-ai/qodercli",
  untested: true,
  notes:
    "2026-07-30 校准。依据:官方 docs(cli/using-cli、permissions、model)+ **npm 包 " +
    "@qoder-ai/qodercli@1.1.8 的 bundle 静态核对**(commander 的选项定义、参数校验分支、" +
    "输出用的 zod schema 都在里面,比文档权威);**本机没装 qodercli,一次都没实跑**,故留 untested。" +
    "已核实:①`-p` 是 `--print` 的布尔开关,正文走位置参数 `[query...]`(\"Initial prompt.\")," +
    "所以 spec 写成 `-p <正文>`,与官方 README 的 `qodercli -p \"…\"` 一致;主命令开了 " +
    "allowUnknownOption,所以**正文以 - 开头会被当未知选项静默丢掉**,真撞上就换隐藏的 `--prompt <text>`;" +
    "②`--yolo` = `--dangerously-skip-permissions` = `--permission-mode bypass_permissions`(三者同义)," +
    "headless 下未预授权的确认会自动变 deny(不会挂住,但活干不完),所以必须带;管理员的 " +
    "security.disableYoloMode、以及非信任目录退回 default 都会让它失效;" +
    "③`--output-format` 只收 text|json|stream-json,`--include-partial-messages` 有硬校验" +
    "「requires --print and --output-format=stream-json」(两条都满足),**没有 claude 那道 --verbose 门槛**;" +
    "④输出 schema 与 claude 同源但没复用 claudeStreamJsonParser,原因见文件头注释;" +
    "⑤`--session-id` 收 UUID(正则 /^[0-9a-f]{8}-…$/,harness 的 randomUUID 合规),与 `-c`/`-r` " +
    "互斥(除非 `--fork-session`),id 撞上已有会话会报 already in use;续跑用 `--resume <id>`;" +
    "⑥`--model/-m` 的档位枚举是 auto|ultimate|performance|efficient|lite,前沿模型(qwen3.7-max 等)" +
    "和 BYOK 自定义模型只能在 TUI 的 /model 里配,配好后可手填 id;" +
    "⑦`--reasoning-effort` 收 low|medium|high|xhigh|max(还接 disabled/off/none 与正整数)," +
    "模型不支持该档位会被 CLI 拒。" +
    "刻意不写的:**relay** —— BYOK 只有 TUI 里的供应商选择器(百炼/Z.ai/Kimi/MiniMax),没有 base_url " +
    "或 key 的 env/flag 通道,headless 鉴权是 Qoder 自家的 PAT(SDK 侧读 QODER_PERSONAL_ACCESS_TOKEN)," +
    "不是第三方中转;**fastArgs** —— /fast 只是斜杠命令(且仅 Kimi-K2.7-Code 有),无对应 flag。" +
    "仍未确认:①真跑一次非交互回合(能否落文件、stream-json 实际长什么样);" +
    "②`--include-partial-messages` 是隐藏 flag,是否每个版本都真吐 stream_event(吐不出来时靠上面那份 " +
    "parser 从完整消息补正文,不会空白);③CLI(而非 SDK)侧的 PAT 环境变量名是否同名。",
  exec: {
    // -p 走 prompt 那一项(装配时排在最后),这里只放输出格式与免确认。
    baseArgs: ["--output-format", "stream-json", "--include-partial-messages", "--yolo"],
    prompt: { via: "flag", flag: "-p" },
    model: { flag: "--model" },
    reasoningEffort: { flag: "--reasoning-effort" },
    session: {
      newIdFlag: "--session-id",
      resumeArgs: (id) => ["--resume", id],
      interactive: (id) => `qodercli --resume ${id}`,
    },
    parser: qoderStreamJsonParser,
  },
};
