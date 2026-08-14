import { createInterface } from "node:readline";
import type { AgentEvent } from "@harness/shared";
import { RunTraceRecorder } from "../diagnostics.js";
import { forceFinishOnExit, spawnErrorMessage } from "../spawn.js";
import type { CliParser, CliParserContext, CliSpec } from "./types.js";

// ⚠️ 这一项本轮**换了对象**:原 stub 写的是「Inflection 的 Pi 对话 CLI」,但 2026-07-30
// 核实的结论是 —— Inflection 的 Pi(pi.ai)只有网页/手机端与一个纯聊天 HTTP API,
// **官方从来没发过 CLI**(能搜到的 `inflection-pi-api` 是第三方 PyPI 包、2023 年后没动过,
// 且它包着的模型没有工具调用,当不了编码执行器)。而终端里 `pi` 这个命令名的实际主人是
// **Earendil 的 Pi Coding Agent**(pi.dev,MIT,npm `@earendil-works/pi-coding-agent`),
// 一个真有 read/bash/edit/write 工具、有非交互模式和 JSON 事件流的编码智能体。
//
// 所以 bins:["pi"] 这个占位其实**猜对了命令名、猜错了产品**。保留 key="pi"、把 name /
// description / 三个检测字段一起校准到真正拥有这个 bin 的产品,是唯一能让本条目自洽的
// 写法:否则界面会把一个编码智能体标成「Inflection 对话 CLI」,还会按聊天 CLI 的假设去
// 拼命令行。用户已确认(2026-07-30):要的就是 pi.dev 的这个 Pi。
export const piSpec: CliSpec = {
  key: "pi",
  name: "Pi",
  description: "Earendil 的开源终端编码智能体",
  // 2026-07-30 依据:npm 包 @earendil-works/pi-coding-agent@0.83.0 的 package.json
  // `"bin": { "pi": "dist/cli.js" }` —— bin 名就是 `pi`,与产品名一致(这次不用像
  // trae→traecli 那样拐弯)。GitHub: earendil-works/pi(旧名 badlogic/pi-mono)。
  bins: ["pi"],
  // 2026-07-30 依据:README 的 "Read the documentation" 指向这里;docs 源码在仓库
  // packages/coding-agent/docs。pi.dev 根是产品页,CLI 参考在 /docs/latest 下。
  docsUrl: "https://pi.dev/docs/latest",
  // 2026-07-30 依据:官方 README/官网都把 `--ignore-scripts` 写进推荐装法
  // (「pi does not require install scripts for normal operation」,供应链加固的一部分),
  // 所以照抄原文带上它。另有 shell 装法 `curl -fsSL https://pi.dev/install.sh | sh`,
  // 但 npm 那条跨平台且可复现,选它。
  installCommand: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
  untested: true,
  notes:
    "⚠️ 身份已校准:原 stub 写的 Inflection Pi **没有官方 CLI**(pi.ai 只有网页/手机端 + 纯聊天 API," +
    "第三方 inflection-pi-api 停更于 2023 且模型无工具调用);`pi` 这个命令名的实际主人是 Earendil 的 " +
    "Pi Coding Agent(pi.dev / GitHub earendil-works/pi,MIT)。本条目已整体改指后者(用户 2026-07-30 确认)。" +
    "执行参数依据 2026-07-30 阅读的 v0.83.0 源码(packages/coding-agent/src/cli/args.ts 的 parseArgs+printHelp、" +
    "modes/print-mode.ts、main.ts 的 resolveAppMode/readPipedStdin/session 解析、core/session-manager.ts)与 docs/json.md," +
    "**本机未装、未实测,故 untested 保留**。要点:" +
    "①非交互没有子命令:`--print/-p` 就是「处理完 prompt 就退出」,`--mode json` 直接进 JSON 打印模式;" +
    "resolveAppMode 还会在 stdin/stdout 不是 TTY 时自动落到 print 模式,所以 harness 下三重保险不会卡交互;" +
    "②**没有权限确认这一环**,官方明说「不含内置权限系统,以启动它的用户权限运行」,所以不需要 --yolo 类 flag" +
    "(要隔离靠容器/沙箱);项目级信任(--approve/-a)在非交互模式下 confirm 直接返回 false、**不会阻塞**," +
    "代价只是不加载仓库自带的 extension/skill —— 需要就自己在 profile 里加 -a;" +
    "③prompt 走 stdin:main.ts 的 readPipedStdin() 在非 TTY 时读满 stdin,buildInitialMessage 把它拼成初始消息;" +
    "④`--session-id <id>` 语义与 claude 的完全一致(main.ts:先按 id 在本项目找,找到就 open 续聊,找不到就用这个 id 新建)," +
    "且 assertValidSessionId 的正则接受 UUID,所以走 harness 自己发 id 那一档;它与 --continue/--resume/--session 互斥,故都不带;" +
    "⑤`--thinking` 的合法档位是 off/minimal/low/medium/high/xhigh/max(args.ts 的 VALID_THINKING_LEVELS,docs/models.md 同口径);" +
    "⑥模型是「provider/id」或模糊匹配(`sonnet`、`sonnet:high` 都行),默认 provider 是 google,权威清单是 `pi --list-models`。" +
    "仍未确认/刻意不做的点:" +
    "①**bin 名冲突风险**:HyperHQ 2018 年那个容器 CLI 也叫 `pi`,主 bin 按设计不做 --version 自证(fallbackVersionMatch 只管备用名)," +
    "所以本机装过那个老 CLI 的话会误检 —— 交给实测确认,没有为此擅改共享的检测机制;" +
    "②relay 故意没写:pi 换 base_url 只能靠 ~/.pi/agent/models.json 的 provider 覆写或写一个 registerProvider 扩展," +
    "**没有「一个环境变量改 base url」的通道**(help 里唯一的 base-url 环境变量是 Azure 专用的);它有 `--api-key` 但那会把密钥写进 argv," +
    "违反「密钥只走 env」,所以宁可让它用自己的账号(供应商侧的 ANTHROPIC_API_KEY/OPENAI_API_KEY 等它本来就认);" +
    "③没用 `--tools` 收紧工具集:它是**allowlist**且同时作用于扩展/自定义工具,写死会把用户装的扩展工具一起关掉;" +
    "默认开 read/bash/edit/write(grep/find/ls 默认关,可用 bash 代替);" +
    "④auto_retry_* / compaction_* 事件只落 trace 不进时间线(长时间重试时界面会显得静默,实测后可再补)。" +
    "2026-08-13 补:本机确实装着这个 pi,`pi --list-models` 已实测(输出定宽表,前两列 provider/model)," +
    "所以模型清单走实时探测;但**执行链路仍未实测**,untested 保留。" +
    "harness 这一半已验证(用一个假 `pi` 走完 GenericCliExecutor 全程):argv 装配为 " +
    "`-p --mode json --session-id <uuid> --model … --thinking …`(-p 后面紧跟 flag,不会误吃参数)、" +
    "prompt 确实经 stdin 送达且子进程侧 isTTY=false、新建/续跑共用 --session-id、" +
    "恢复命令为 `cd <cwd> && pi --session-id <id>`、parser 能把合成事件流映射成 " +
    "session/tool/thinking/text 并在「exit 0 但 stopReason=error」时照样报错、非 JSON 行退回正文、" +
    "事件流以 done 收尾。**没验到的是 pi 自己**(真实 flag 行为与事件形状),所以 untested 保留。",
  exec: {
    // -p:非交互,处理完就退出。--mode json:把整条会话事件流按 JSONL 打到 stdout
    // (给下面的 parser 用)。两个都带是刻意的:--mode json 已经隐含 print 模式,
    // -p 只是让「绝不进 TUI」不依赖 TTY 探测。注意 -p 会顺手吃掉紧跟其后的非 flag
    // 参数当消息,所以它后面必须是 flag —— 这里跟着 --mode,且 prompt 走 stdin。
    baseArgs: ["-p", "--mode", "json"],
    // main.ts 的 readPipedStdin():非 TTY 时读满 stdin,再由 buildInitialMessage
    // 拼成初始消息。任务正文动辄上千字,走 stdin 不撞 argv 上限、也不用转义。
    prompt: { via: "stdin" },
    model: { flag: "--model" },
    // pi 把「思考强度」叫 thinking(off/minimal/low/medium/high/xhigh/max)。
    reasoningEffort: { flag: "--thinking" },
    // 没有 1.5x 加速档这个概念,故不写 fastArgs。
    //
    // --session-id 是「按 id 打开,没有就用这个 id 新建」,等于 claude 的 --session-id:
    // harness 自己发 UUID 即可(assertValidSessionId 接受 UUID),新建和续跑用同一个 flag。
    session: {
      newIdFlag: "--session-id",
      resumeArgs: (id) => ["--session-id", id],
      interactive: (id) => `pi --session-id ${id}`,
    },
    parser: (ctx) => piEvents(ctx),
  },
  // `pi --list-models` 是纯本地查询(读它自带的 models 目录 + 已认证 provider),
  // 不起会话、不烧 token。2026-08-13 本机实测(v0.83.x)输出是一张定宽表:
  //   provider   model                       context  max-out  thinking  images
  //   anthropic  claude-fable-5              1M       128K     yes       yes
  // pi 的 --model 收 `provider/id`,所以前两列拼起来才是能直接填进去的取值。
  models: { args: ["--list-models"], parse: (stdout) => parsePiModels(stdout) },
};

/**
 * `pi --list-models` 的表格 → `provider/model` 清单。
 *
 * 只认「前两列都是模型 id 长相」的行:表头(provider/model)与任何说明性文字都不满足,
 * 于是格式一变就是解析出空数组、如实降级到内置快照,而不是把 "context" 当模型名端上去。
 */
export function parsePiModels(stdout: string): { models: string[]; defaultModel?: string | null } {
  const models: string[] = [];
  for (const line of stdout.split("\n")) {
    const cols = line.trim().split(/\s{2,}/);
    if (cols.length < 2) continue;
    const [provider, model] = cols as [string, string];
    if (provider === "provider" || model === "model") continue; // 表头
    if (!/^[a-z0-9][\w.-]*$/i.test(provider) || !/^[a-z0-9][\w.:-]*$/i.test(model)) continue;
    models.push(`${provider}/${model}`);
  }
  return { models, defaultModel: null };
}

/**
 * `pi --mode json` 的 JSONL 解析(schema 见 docs/json.md;发送处是 print-mode.ts 里
 * 对每个 session 事件的 `JSON.stringify(event)`)。
 *
 * 用到的行:
 *   {type:"session",id,…}                     首行会话头 —— 带回 cliSessionId(与我们传进去的 --session-id 应一致)
 *   {type:"message_end",message}              一条消息收尾:role=assistant 时取 content 里的 text / thinking 块
 *   {type:"tool_execution_start",toolName,args}   工具开跑
 *   {type:"tool_execution_end",toolName,result,isError}  只在失败时补一行
 * 其余(message_start/message_update 的增量、turn_*、agent_*、queue_update、
 * compaction_*、auto_retry_* …)只落 trace:正文取自 message_end 的完整消息,
 * 所以不订阅 text_delta —— 两个都收会把正文说两遍。
 *
 * **json 模式下 LLM 出错也可能 exit 0**:print-mode.ts 只在 text 模式里把
 * stopReason=error/aborted 翻成 exitCode 1,json 模式一路返回 0。所以错误必须由这里
 * 从 assistant 消息的 stopReason/errorMessage 里认出来,不能指望退出码。
 *
 * 解析不出 JSON 的行**退回当正文**:装机版本万一不认 `--mode`(那时它仍会因为
 * stdin 非 TTY 走 text print 模式,往 stdout 打人话),这样至少还等于 textParser。
 */
const piEvents: CliParser = async function* (ctx: CliParserContext): AsyncIterable<AgentEvent> {
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

    switch (ev.type) {
      case "session": {
        // 会话头。id 正常就是我们用 --session-id 传进去的那个;万一 pi 换了个 id
        // 建会话,以它回报的为准(写进 sessions.cli_session_id 才续得上)。
        if (!sessionSent && typeof ev.id === "string" && ev.id) {
          sessionSent = true;
          push({ kind: "session", cliSessionId: ev.id });
        }
        break;
      }
      case "message_end": {
        const msg = (ev.message ?? {}) as Record<string, unknown>;
        if (msg.role !== "assistant") break;
        for (const block of Array.isArray(msg.content) ? msg.content : []) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          // toolCall 块跳过:工具已由 tool_execution_* 报过,再报一遍是重复。
          if (b.type === "text" && typeof b.text === "string" && b.text) {
            push({ kind: "text", text: b.text.endsWith("\n") ? b.text : b.text + "\n" });
          } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking) {
            push({ kind: "thinking", text: b.thinking });
          }
        }
        if (msg.stopReason === "error" || msg.stopReason === "aborted") {
          sawError = true;
          if (!lifecycle.stopRequested) {
            const detail = typeof msg.errorMessage === "string" && msg.errorMessage ? msg.errorMessage : String(msg.stopReason);
            push({ kind: "error", message: `${ctx.label} 回合失败：${clip(detail, 2000)}` });
          }
        }
        break;
      }
      case "tool_execution_start": {
        const name = typeof ev.toolName === "string" ? ev.toolName : "tool";
        push({ kind: "tool", name, detail: summarizeArgs(ev.args) });
        break;
      }
      case "tool_execution_end": {
        // 成功的收尾不重复报;失败的补一行,否则时间线上只看得见「开跑」。
        if (ev.isError !== true) break;
        const name = typeof ev.toolName === "string" ? ev.toolName : "tool";
        const detail = summarizeArgs(ev.result);
        push({ kind: "tool", name, detail: detail ? `失败：${detail}` : "失败" });
        break;
      }
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
      // 已经从 stopReason 报过一次的就不再重复。
      push({
        kind: "error",
        message: tail
          ? `${ctx.label} 以 exit ${opts.exitStatus} 结束：${clip(tail, 2000)}`
          : `${ctx.label} 以 exit ${opts.exitStatus} 结束,且 stderr 为空(命令行参数可能不对)`,
      });
    else if (!lifecycle.stopRequested && opts.exitStatus === 0 && stdoutLines === 0)
      push({
        kind: "error",
        message:
          `${ctx.label} 以 exit 0 结束但没有任何 stdout 输出 —— 多半是非交互参数不对` +
          `(执行参数在 server/src/executors/catalog/pi.ts${tail ? `;stderr:${clip(tail, 500)}` : ""})`,
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

// 工具事件的一行摘要。pi 的内置工具入参是 {command}/{path,…},扩展工具形状未知,
// 所以先挑常见键,挑不到再退回整串 JSON。
function summarizeArgs(raw: unknown): string | undefined {
  if (typeof raw === "string") return clip(raw, 200) || undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  for (const k of ["command", "path", "filePath", "file_path", "pattern", "glob", "url", "description"]) {
    if (typeof obj[k] === "string" && obj[k]) return clip(obj[k] as string, 200);
  }
  try {
    return clip(JSON.stringify(obj), 200) || undefined;
  } catch {
    return undefined;
  }
}

const clip = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max) + "…");
