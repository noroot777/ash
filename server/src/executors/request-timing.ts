// 每次模型请求「发出 → 最后一个 token」花了多久,攒成一回合的 OutputTiming(口径见
// shared/src/usage.ts)。claude 只在**原始流**里露出请求的起止,出了解析那一层就再也拿不回来,
// 所以计时在这里做,随回合的 usage 事件带出去。codex 的在 ./codex-rollout-timing.ts。
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
