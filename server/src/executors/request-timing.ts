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
 *
 * 两头都要**有凭据**才计,哪一头说不清就整次丢掉:
 *  - 起点:上一次请求开出去的工具必须全都带时间戳收了尾,否则不知道输入何时齐;一个「输入齐了」
 *    的时刻只给紧接着的那一次请求用,用过就作废,不会被再下一次请求捡去当起点。
 *  - 终点:这次的思考/正文都得带时间戳收尾;同一次回复里有工具已经跑完、之后才又冒出东西的,
 *    分不清那是模型还在写、还是后一个工具在排队等前一个,也不计。
 */
export class CodexRequestTimer {
  private ready: number | null = null;
  private inputUnknown = false;
  private readonly pendingTools = new Set<string>();
  private response: CodexResponse | null = null;
  private readonly total = new TimingTotal();

  notification(method: string, p: any): void {
    const type = p?.item?.type;
    const id = typeof p?.item?.id === "string" ? p.item.id : null;
    if (typeof type === "string" && type !== "userMessage" && method === "item/started") {
      this.started(type, id, p.startedAtMs);
    } else if (typeof type === "string" && method === "item/completed") {
      this.completed(type, id, p.completedAtMs);
    } else if (method === "thread/tokenUsage/updated") {
      const r = this.response;
      this.response = null;
      const output = p?.tokenUsage?.last?.outputTokens;
      if (r && !r.broken && r.start !== null && r.last !== null && r.openModel.size === 0 && typeof output === "number") {
        this.total.add(output, r.last - r.start);
      }
    }
  }

  take(): OutputTiming | undefined {
    this.ready = null;
    this.inputUnknown = false;
    this.pendingTools.clear();
    this.response = null;
    return this.total.take();
  }

  private started(type: string, id: string | null, at: unknown): void {
    const r = this.current();
    const tool = !MODEL_ITEMS.has(type);
    if (tool) {
      if (id) this.pendingTools.add(id);
      else this.inputUnknown = true; // 认不出是谁,就等不到它收尾:下一次请求的起点从此说不清
    }
    if (typeof at !== "number" || !id || r.toolDoneAt !== null || (r.start !== null && at < r.start)) {
      r.broken = true;
      return;
    }
    r.last = Math.max(r.last ?? at, at);
    if (tool) r.tools.add(id);
    else r.openModel.add(id);
  }

  private completed(type: string, id: string | null, at: unknown): void {
    const timed = typeof at === "number";
    if (type === "userMessage") {
      if (timed) this.ready = Math.max(this.ready ?? at, at);
      else this.inputUnknown = true;
      return;
    }
    if (MODEL_ITEMS.has(type)) {
      const r = this.response;
      if (!r) return;
      if (!id || !r.openModel.delete(id) || !timed) r.broken = true;
      else r.last = Math.max(r.last ?? at, at);
      return;
    }
    if (!id || !this.pendingTools.has(id) || !timed) return; // 没带时间戳就留在 pendingTools 里
    this.pendingTools.delete(id);
    this.ready = Math.max(this.ready ?? at, at);
    if (this.response?.tools.has(id)) this.response.toolDoneAt ??= at;
  }

  /** 这一次请求;第一次出货时开出来,同时认领(并作废)那个「输入齐了」的时刻。 */
  private current(): CodexResponse {
    if (!this.response) {
      const known = !this.inputUnknown && this.pendingTools.size === 0;
      this.response = { start: known ? this.ready : null, last: null, openModel: new Set(), tools: new Set(), toolDoneAt: null, broken: false };
      this.ready = null;
      this.inputUnknown = false;
    }
    return this.response;
  }
}

type CodexResponse = {
  start: number | null;
  last: number | null;
  /** 开始了、还没带时间戳收尾的思考/正文。 */
  openModel: Set<string>;
  /** 这次回复里开跑的工具。 */
  tools: Set<string>;
  /** 这次回复里第一个工具跑完的时刻。 */
  toolDoneAt: number | null;
  broken: boolean;
};

/** 模型自己写出来的 item。其余(命令、MCP、改文件、看图…)都是工具:开始 = 模型写完调用,完成 = 结果回来。 */
const MODEL_ITEMS = new Set(["reasoning", "agentMessage", "plan"]);
