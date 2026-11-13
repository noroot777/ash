// 每次模型请求「发出 → 最后一个 token」花了多久,攒成一回合的 OutputTiming(口径见
// shared/src/usage.ts)。各家 CLI 只在**原始流**里露出请求的起止,出了执行器就再也拿不回来,
// 所以计时只能在解析那一层做,随回合的 usage 事件带出去。
//
// 起点算到「请求发出」而不是「第一个 token 到达」:codex 不报首字时间,两家要放在一起比,
// 就只能都按端到端算。起止有一头没看见的请求整次不计,宁缺不估。
import type { OutputTiming } from "@ash/shared";

class TimingTotal {
  private output = 0;
  private ms = 0;

  add(output: number, ms: number): void {
    if (!(output > 0) || !(ms > 0) || !Number.isFinite(ms)) return;
    this.output += Math.round(output);
    this.ms += Math.round(ms);
  }

  /** 交出这一回合攒下的,并清零。一次都没计上就是 undefined。 */
  take(): OutputTiming | undefined {
    const timed = this.output > 0 && this.ms > 0 ? { output: this.output, ms: this.ms } : undefined;
    this.output = 0;
    this.ms = 0;
    return timed;
  }
}

/**
 * claude 的 `--include-partial-messages` 流:每次请求一组 `message_start`(带 CLI 量的
 * `ttft_ms`)→ `message_delta`(带这次的输出 token)→ `message_stop`。起点 = message_start
 * 到达时刻倒推 ttft_ms。子智能体的请求跟主线程交错着到,按 parent_tool_use_id 分开记。
 *
 * 用的是 ash 读到这一行的时刻,所以**接管重放的那段不能喂进来**(那是一口气读完的旧输出)。
 */
export class ClaudeRequestTimer {
  private readonly open = new Map<string, { start: number; output: number }>();
  private readonly total = new TimingTotal();

  event(ev: any, now = Date.now()): void {
    if (ev?.type !== "stream_event") return;
    const key = typeof ev.parent_tool_use_id === "string" ? ev.parent_tool_use_id : "";
    const se = ev.event;
    if (se?.type === "message_start") {
      if (typeof ev.ttft_ms === "number" && ev.ttft_ms >= 0) this.open.set(key, { start: now - ev.ttft_ms, output: 0 });
      else this.open.delete(key);
    } else if (se?.type === "message_delta") {
      const request = this.open.get(key);
      if (request && typeof se.usage?.output_tokens === "number") request.output = se.usage.output_tokens;
    } else if (se?.type === "message_stop") {
      const request = this.open.get(key);
      this.open.delete(key);
      if (request) this.total.add(request.output, now - request.start);
    }
  }

  take(): OutputTiming | undefined {
    return this.total.take();
  }
}

/**
 * codex app-server 的主线程通知。item 自带 codex 自己的时间戳(startedAtMs/completedAtMs),
 * 不受 ash 读得快慢影响。一次请求的边界是 `thread/tokenUsage/updated`(它带这一次的 last 用量):
 *  - 起点 = 这次请求第一次出货之前,最后一个工具结果(或用户消息)完成的时刻 —— 输入齐了才发得出去;
 *  - 终点 = 模型这次写出来的最后一样东西:思考/正文的完成,或工具调用的开始(调用参数写完,
 *    工具才开跑)。工具跑多久不算模型的时间。
 */
export class CodexRequestTimer {
  private ready: number | null = null;
  private start: number | null = null;
  private last: number | null = null;
  private readonly total = new TimingTotal();

  notification(method: string, p: any): void {
    const type = p?.item?.type;
    if (method === "item/started" && typeof type === "string" && type !== "userMessage") {
      this.produced(p.startedAtMs);
    } else if (method === "item/completed" && typeof type === "string") {
      if (type === "userMessage" || !MODEL_ITEMS.has(type)) this.inputReady(p.completedAtMs);
      else this.produced(p.completedAtMs);
    } else if (method === "thread/tokenUsage/updated") {
      const output = p?.tokenUsage?.last?.outputTokens;
      if (this.start !== null && this.last !== null && typeof output === "number") this.total.add(output, this.last - this.start);
      this.start = null;
      this.last = null;
    }
  }

  take(): OutputTiming | undefined {
    this.ready = null;
    return this.total.take();
  }

  private inputReady(at: unknown): void {
    if (typeof at === "number") this.ready = Math.max(this.ready ?? at, at);
  }

  private produced(at: unknown): void {
    if (typeof at !== "number") return;
    if (this.last === null) this.start = this.ready !== null && this.ready <= at ? this.ready : null;
    this.last = Math.max(this.last ?? at, at);
  }
}

/** 模型自己写出来的 item。其余(命令、MCP、改文件、看图…)都是工具:开始 = 模型写完调用,完成 = 结果回来。 */
const MODEL_ITEMS = new Set(["reasoning", "agentMessage", "plan"]);
