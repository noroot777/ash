import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentEvent, AgentType, ExecTarget, TokenUsage } from "@harness/shared";
import { guessContextWindow } from "@harness/shared/usage";
import type { AgentExecutor, RelayConfig, ResidentHandle, RunHandle, RunOpts } from "./types.js";
import { spawnForRun, detachedInfo } from "./detached.js";
import { spawnAgent, resumeFor, resumeInner, spawnErrorMessage, killChild, forceFinishOnExit, redactSecrets } from "./spawn.js";
import { relayRoot } from "../llm.js";
import { calibrateSkills } from "../skills.js";
import { persistMarkdownImages, persistToolResultImages } from "../agent-attachments.js";

// Drives the real `claude` CLI in headless stream-json mode (prompt via stdin).
//   claude -p --output-format stream-json --verbose --dangerously-skip-permissions
//          (--session-id <uuid> | --resume <uuid>) [--model <m>]
export class ClaudeExecutor implements AgentExecutor {
  readonly type = "claude" as const;
  readonly label: string;
  // 供应商的 env 前缀,token 已换成占位符 —— 存进 sessions.relay_env 供恢复命令展示。
  readonly relayEnvHint?: string;
  readonly target: ExecTarget;
  private bin: string;
  private model?: string;
  private extraArgs: string[];
  private reasoningEffort?: string;
  private speed?: "fast";
  private relay?: RelayConfig;
  constructor(opts: { model?: string; extraArgs?: string[]; reasoningEffort?: string; speed?: "fast"; bin?: string; target?: ExecTarget; name?: string; relay?: RelayConfig } = {}) {
    this.model = opts.model;
    this.extraArgs = opts.extraArgs ?? [];
    this.reasoningEffort = opts.reasoningEffort;
    this.speed = opts.speed;
    this.bin = opts.bin ?? "claude";
    this.target = opts.target ?? { kind: "local" };
    this.relay = opts.relay;
    this.relayEnvHint = this.relay
      ? `ANTHROPIC_BASE_URL=${relayRoot(this.relay.baseUrl)} ANTHROPIC_AUTH_TOKEN=<你的key> `
      : undefined;
    const where = this.target.kind === "ssh" ? this.target.host : "local";
    this.label = opts.name ?? `claude@${where}${opts.model ? "·" + opts.model : ""}`;
  }

  // 只有跑在**本机**的 claude 才配校准技能缓存:ssh 上那份技能装在远端盘上,
  // 本机扫不出来也对不上,拿它的清单去覆盖本机结果只会凭空多出一批点不动的技能。
  private calibrateAs(): AgentType | undefined {
    return this.target.kind === "local" ? this.type : undefined;
  }

  resumeCommand(cwd: string, sessionId: string): string {
    return resumeFor(this.target, cwd, resumeInner.claude(sessionId), this.relayEnvHint ?? "");
  }

  // 挂了供应商就顶掉 CLI 自己的登录态:BASE_URL 指到供应商根地址(SDK 自己会补 /v1,
  // 库里那份要是带了 /v1 得剥掉,否则打到 /v1/v1),AUTH_TOKEN 给它的 key。
  private env(): Record<string, string> | undefined {
    if (!this.relay) return undefined;
    return { ANTHROPIC_BASE_URL: relayRoot(this.relay.baseUrl), ANTHROPIC_AUTH_TOKEN: this.relay.apiKey };
  }

  run(opts: RunOpts): RunHandle {
    const sessionId = opts.sessionId ?? randomUUID();
    const args = this.buildArgs(opts, sessionId, false);
    const commandLine = redactSecrets(`${this.bin} ${args.join(" ")} <prompt via stdin>`);
    const child = spawnForRun(this.target, opts.cwd, this.bin, args, opts.prompt, this.env(), opts.detach);
    return { sessionId, commandLine, events: parseClaudeStream(child, undefined, this.bin, this.calibrateAs()), kill: () => killChild(child), detached: detachedInfo(child) };
  }

  attach(child: ChildProcess, opts: { sessionId: string; commandLine: string }): RunHandle {
    return {
      sessionId: opts.sessionId,
      commandLine: opts.commandLine,
      events: parseClaudeStream(child, undefined, this.bin, this.calibrateAs()),
      kill: () => child.kill(),
      detached: detachedInfo(child),
    };
  }

  // 常驻会话(§Team 的调度台):一个进程吃多个回合,session_id 全程不变。跟 run()
  // 的差别只有两处 —— `--input-format stream-json`(首条消息和后续插话都是一行
  // JSON)和不关 stdin。实测事实与坑写在 server/src/team/session.ts 头部注释。
  openResident(opts: RunOpts): ResidentHandle {
    const sessionId = opts.sessionId ?? randomUUID();
    const args = this.buildArgs(opts, sessionId, true);
    const commandLine = redactSecrets(`${this.bin} ${args.join(" ")} <messages via stdin>`);
    const child = spawnAgent(this.target, opts.cwd, this.bin, args, userLine(opts.prompt), this.env(), {
      keepStdin: true,
    });
    const resident = { interruptPending: false };
    let reqSeq = 0;
    return {
      sessionId,
      commandLine,
      events: parseClaudeStream(child, resident, this.bin, this.calibrateAs()),
      send: (text: string) => {
        child.stdin?.write(userLine(text));
      },
      interrupt: () => {
        resident.interruptPending = true;
        child.stdin?.write(
          JSON.stringify({
            type: "control_request",
            request_id: `harness_int_${++reqSeq}`,
            request: { subtype: "interrupt" },
          }) + "\n",
        );
      },
      close: () => child.stdin?.end(),
      kill: () => killChild(child),
    };
  }

  // 两种形态共用的参数装配。resident 只多一个 --input-format。
  private buildArgs(opts: RunOpts, sessionId: string, resident: boolean): string[] {
    const model = opts.model ?? this.model;
    // --include-partial-messages turns on token-level streaming: the CLI emits
    // `stream_event` lines (content_block_delta) AS the model types, instead of
    // only one complete `assistant` message per turn. Without it the mobile/web
    // client sees nothing until a whole message lands, then the entire block
    // appears at once — the "laggy, dumps-in-one-go" feel. See parseClaudeStream.
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--dangerously-skip-permissions"];
    // stdin 从「一次性 prompt」变成「一行行 JSON 消息」(CLI help 原文:realtime
    // streaming input),于是同一进程能连吃多个回合。
    if (resident) args.push("--input-format", "stream-json");
    if (opts.sessionId) args.push("--resume", sessionId);
    else args.push("--session-id", sessionId);
    if (model) args.push("--model", model);
    if (this.reasoningEffort) args.push("--effort", this.reasoningEffort);
    // 1.5x 加速档:headless 下开 fast mode 的唯一官方通道是 --settings 传
    // fastMode(无 --fast flag、无启用型环境变量;仅 Opus 系列生效,其余模型
    // CLI 自行忽略)。放在 extraArgs 之前,用户如自带 --settings 以后者为准。
    if (this.speed === "fast") args.push("--settings", '{"fastMode": true}');
    // 注册表配置的固定参数在前,单次调用的 opts.extraArgs 在后(后者可覆盖前者)。
    if (this.extraArgs.length) args.push(...this.extraArgs);
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);
    return args;
  }
}

// stream-json 的入站格式:一条 user 消息 = 一行 JSON。
const userLine = (text: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";

// resident 非空 = 常驻模式:`result` 行只代表「一个回合说完了」(→ turnEnd),
// 流要一直开着;只有进程真的没了才 done。
// bin 只影响 spawn 报错文案 —— 导出是为了让目录里「输出格式跟 claude 一致」的
// CLI(stream-json 的 --output-format)直接复用这一份解析,不必各写一遍。
// calibrateAs:只有**确知自己是哪种 CLI 的本机进程**才传(见下面 init 分支)。
// 复用这份 parser 的第三方 CLI 一律不传 —— 它们的技能名跟 claude 的不是一回事,
// 拿 bin 名去猜会把别人的技能塞进 claude 的缓存。
export async function* parseClaudeStream(
  child: ReturnType<typeof spawnAgent>,
  resident?: { interruptPending: boolean },
  bin = "claude",
  calibrateAs?: AgentType,
): AsyncIterable<AgentEvent> {
  const queue: AgentEvent[] = [];
  let resolve: (() => void) | null = null;
  let finished = false;
  const push = (e: AgentEvent) => {
    queue.push(e);
    resolve?.();
    resolve = null;
  };

  // Coalesce token-level text_delta into small chunks: flush on a newline or once
  // ~40 chars have accrued, so the client streams smoothly without a re-render per
  // character (a long reply would otherwise fire thousands of setStates). The
  // chunks concatenate downstream with no separator, so the joined text is exactly
  // the model's output. With partial streaming ON, the complete `assistant`
  // message that trails the deltas is used ONLY for tool_use — replaying its text
  // would duplicate everything the deltas already streamed.
  let textBuf = "";
  const flushText = () => {
    if (textBuf) {
      push({ kind: "text", text: textBuf });
      textBuf = "";
    }
  };

  // 上下文水位。**只有 `assistant` 事件里的 `message.usage` 是单次 API 调用的快照**
  // —— 收尾的 `result` 行是整回合累加(几十次调用相加,长会话能到千万级),拿它当水位
  // 会得出「上下文爆了 50 倍」。所以在这里逐条记下最新一次调用的输入规模,回合结束
  // 时发一条 context 事件。窗口(分母)反过来只有 `result` 行有,见 claudeContextWindow。
  let contextUsed = 0;
  let contextModel: string | null = null;
  const seenImages = new Set<string>();

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      return;
    }
    if (ev.type === "stream_event") {
      const se = ev.event;
      if (se?.type === "content_block_delta" && se.delta?.type === "text_delta" && se.delta.text) {
        textBuf += se.delta.text;
        if (textBuf.length >= 40 || textBuf.includes("\n")) flushText();
      }
      return; // deltas drive the live stream; the trailing complete message handles tools
    }
    if (ev.type === "system" && ev.session_id) {
      // init 事件白送一份**权威**技能清单(skills / slash_commands / cwd 都在里面),
      // 顺手校准 skills 模块的扫描结果 —— 这是唯一不用额外起一个 CLI 进程就能拿到
      // 「这个 CLI 自己认哪些技能」的机会,别浪费。纯旁路:失败也不能影响事件流。
      if (calibrateAs && ev.subtype === "init" && typeof ev.cwd === "string") {
        try {
          calibrateSkills(calibrateAs, ev.cwd, ev.skills, ev.slash_commands);
        } catch {
          /* 校准是锦上添花,坏了就还用扫描结果 */
        }
      }
      push({ kind: "session", cliSessionId: ev.session_id });
    } else if (ev.type === "assistant" && ev.message?.content) {
      flushText(); // settle this message's text-delta tail before its tools
      // 这一次 API 调用装了多少进模型 = 上下文水位(见上面 contextUsed 的注释)。
      // 合成消息不是真调用,它的 usage 不代表上下文,跳过。
      if (ev.message.model && ev.message.model !== "<synthetic>") {
        contextModel = ev.message.model;
        const snapshot = claudeContextUsed(ev.message.usage);
        if (snapshot > 0) contextUsed = snapshot;
      }
      // CLI 本地合成的消息(model `<synthetic>`:模型不存在 / 鉴权失败 / 限流等)
      // **不经过 delta 流** —— 它是 CLI 自己拼出来的,不是模型吐的。所以这一类的
      // text 必须照收,跳过就等于把唯一一句错误说明扔了(见 docs/incidents.md
      // 「空白回合」:404 model_not_found 整个被吞,用户只看到任务停着不动)。
      const synthetic = ev.message.model === "<synthetic>";
      let hadText = false;
      for (const block of ev.message.content) {
        if (block.type === "text") {
          hadText = true; // 真模型的 text 已经由 deltas 流过 —— 不要再 push 一遍
          if (synthetic && block.text) push({ kind: "text", text: block.text });
        } else if (block.type === "tool_use") push({ kind: "tool", name: block.name, detail: shortJson(block.input) });
      }
      if (hadText) push({ kind: "text", text: "\n\n" }); // paragraph break, identical live & on reload
      for (const block of ev.message.content) {
        if (block.type !== "text" || typeof block.text !== "string") continue;
        for (const path of persistMarkdownImages(block.text, seenImages)) push({ kind: "attachment", path });
      }
    } else if (ev.type === "user" && Array.isArray(ev.message?.content)) {
      flushText();
      for (const block of ev.message.content) {
        if (block?.type !== "tool_result") continue;
        for (const path of persistToolResultImages(block.content, seenImages)) push({ kind: "attachment", path });
      }
    } else if (ev.type === "result") {
      flushText();
      if (ev.session_id) push({ kind: "session", cliSessionId: ev.session_id });
      const usage = claudeUsage(ev);
      if (usage) push({ kind: "usage", usage });
      // 水位跟着流水一起发。分母优先用 claude 自报的(见 claudeContextWindow ——
      // 1M 窗口只有那儿认得出),自报缺失才退回按模型名估。
      if (contextUsed > 0) {
        const model = contextModel ?? ev.model ?? null;
        const reported = claudeContextWindow(ev, model);
        const window = reported ?? guessContextWindow(model);
        push({
          kind: "context",
          context: { used: contextUsed, window, windowEstimated: reported === null && window !== null },
        });
      }
      // 我们自己发的 interrupt 会把本回合收成 error_during_execution —— 那是
      // 「用户插话打断」的预期结果,不是故障,不报错。只吞掉紧跟其后的那一个
      // result(标志立即清掉),所以最坏情况也只影响一个回合的错误上报。
      const ownInterrupt = resident?.interruptPending === true;
      if (resident) resident.interruptPending = false;
      // claude CLI 把 **API 层**的失败(404 模型不存在、401、限流…)报成
      // `subtype:"success"` + `is_error:true` + `api_error_status` —— 只看 subtype
      // 会把它整条判成正常结束。两路判据都要算上,否则回合「成功」但一个字没说。
      const apiError = ev.is_error === true || typeof ev.api_error_status === "number";
      if (((ev.subtype && ev.subtype !== "success") || apiError) && !ownInterrupt) {
        const detail = typeof ev.result === "string" && ev.result.trim()
          ? ev.result.trim()
          : `result: ${ev.subtype}`;
        push({
          kind: "error",
          message: ev.api_error_status ? `HTTP ${ev.api_error_status}: ${detail}` : detail,
        });
      }
      // 常驻:回合说完了,进程还活着等下一条消息 —— 流不结束。
      if (resident) push({ kind: "turnEnd" });
      seenImages.clear();
    }
  });

  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d.toString()));
  child.on("error", (err: NodeJS.ErrnoException) => {
    if (finished) return;
    push({ kind: "error", message: spawnErrorMessage(bin, err) });
    push({ kind: "done", exitStatus: 1 });
    finished = true;
    resolve?.();
    resolve = null;
  });
  child.on("close", (code) => {
    if (finished) return;
    flushText(); // emit any text tail that never hit the flush threshold
    const exit = code ?? 0;
    if (exit !== 0 && stderr.trim()) push({ kind: "error", message: stderr.trim().slice(0, 2000) });
    push({ kind: "done", exitStatus: exit });
    finished = true;
    resolve?.();
    resolve = null;
  });
  forceFinishOnExit(child, () => finished, (exit) => {
    flushText();
    push({ kind: "error", message: "进程已退出但输出流未正常收尾(疑有残留子进程占用管道),已强制结束本回合" });
    push({ kind: "done", exitStatus: exit });
    finished = true;
    resolve?.();
    resolve = null;
  });

  while (true) {
    if (queue.length) {
      yield queue.shift()!;
      continue;
    }
    if (finished) return;
    await new Promise<void>((r) => (resolve = r));
  }
}

const shortJson = (v: unknown) => {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 1500 ? s.slice(0, 1497) + "…" : s;
  } catch {
    return undefined;
  }
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * 单次 API 调用的**上下文水位**：这一次请求带进模型的输入有多大。
 *
 * 三项都要算：`input_tokens` 是没命中缓存的部分，`cache_read` 是命中缓存的部分，
 * `cache_creation` 是这次新写进缓存的部分 —— 三者合起来才是这一次请求的完整
 * prompt。漏掉缓存那两项，水位会显示成几百 token（实测一次真实调用：input=2、
 * cacheRead=115762、cacheWrite=668，只看 input 就等于什么都没测）。
 */
export function claudeContextUsed(u: any): number {
  if (!u || typeof u !== "object") return 0;
  return num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
}

/**
 * 上下文窗口有多大 —— claude **自报**在 `result.modelUsage.<model>.contextWindow`,
 * 拿到就用,这是唯一准确的分母。
 *
 * 为什么非从这里读、不能按模型名猜:两处模型名**看起来一样但含义不同** ——
 * `assistant` 事件里是 `claude-opus-5`,`modelUsage` 的 key 是 `claude-opus-5[1m]`,
 * 那个 `[1m]` 后缀是 1M 窗口的**唯一线索**,而它只存在于 key 上。也就是说 200k 会话
 * 和 1M 会话的 `message.model` 逐字相同,按名字猜从原理上分不开(实测库里 1M 记录 7 条
 * 也是这个形状)。猜错的后果不是差一点:94% 剩余会显示成 72%,水位过 20 万还会提前
 * 变红报「快满了」。
 *
 * 匹配两步:先精确,再拿 key 剥掉 `[...]` 后缀比。都对不上时**只有 modelUsage 里
 * 恰好只有一项**才敢用它 —— 多项时小模型(跑标题/压缩的 haiku)也在里面,它的 200k
 * 会把主模型的 1M 冒充掉。
 */
export function claudeContextWindow(ev: any, model: string | null): number | null {
  const mu = ev?.modelUsage;
  if (!mu || typeof mu !== "object") return null;
  const pick = (key: string): number | null => {
    const w = mu[key]?.contextWindow;
    return typeof w === "number" && Number.isFinite(w) && w > 0 ? Math.trunc(w) : null;
  };
  if (model) {
    const exact = pick(model);
    if (exact) return exact;
    for (const key of Object.keys(mu)) {
      if (key.replace(/\[[^\]]*\]$/, "") === model) {
        const w = pick(key);
        if (w) return w;
      }
    }
  }
  const keys = Object.keys(mu);
  return keys.length === 1 ? pick(keys[0]!) : null;
}

// `result` 行自带这一回合的账单。两处数据来源,取 **modelUsage** 优先:
//   • `usage`      —— 本回合累加,但只有主模型那一份;
//   • `modelUsage` —— 按模型分组的完整账(小模型跑标题/压缩也在里面),且 costUSD
//                     跟 total_cost_usd 同源。
// 一个都没有(旧版 CLI / 复用这份 parser 的第三方 CLI 不报账)就返回 null ——
// **不要退化成全 0**,那会让界面把「没报账」显示成「没花钱」。
export function claudeUsage(ev: any): TokenUsage | null {
  const models = ev?.modelUsage && typeof ev.modelUsage === "object" ? Object.values<any>(ev.modelUsage) : [];
  const cost = typeof ev?.total_cost_usd === "number" && Number.isFinite(ev.total_cost_usd)
    ? ev.total_cost_usd
    : models.length
      ? models.reduce((sum, m) => sum + num(m?.costUSD), 0)
      : null;
  if (models.length) {
    return {
      input: models.reduce((s, m) => s + num(m?.inputTokens), 0),
      output: models.reduce((s, m) => s + num(m?.outputTokens), 0),
      cacheRead: models.reduce((s, m) => s + num(m?.cacheReadInputTokens), 0),
      cacheWrite: models.reduce((s, m) => s + num(m?.cacheCreationInputTokens), 0),
      reasoning: 0, // claude 不单列思考 token(已含在 output 里)
      costUsd: cost,
      turns: 1,
    };
  }
  const u = ev?.usage;
  if (!u || typeof u !== "object") return null;
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    reasoning: 0,
    costUsd: cost,
    turns: 1,
  };
}
