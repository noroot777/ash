import type { AgentEvent, NativeAgentActivity } from "@ash/shared";
import { codexErrorEvent } from "./codex-error-event.js";
import { claudeRetryMessage, isClaudeRetry } from "./claude-retry-notice.js";
import { codexChangeWrites, codexCommandCwd } from "./tool-writes.js";

export function childActivity(id: string, event: NativeAgentActivity): AgentEvent {
  return { kind: "tool", name: "Agent", nativeWork: { type: "activity", id, event, at: new Date().toISOString() } };
}

const short = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const suffix = "\n…（内容已截断）";
  return text.length > 1500 ? text.slice(0, 1500 - suffix.length) + suffix : text;
};

export class CodexChildActivity {
  private textDeltas = new Set<string>();
  private thinkingDeltas = new Set<string>();

  notification(method: string, p: any): AgentEvent[] {
    const out: AgentEvent[] = [];
    const push = (event: NativeAgentActivity) => out.push(childActivity(p.threadId, event));
    const item = p.item;
    const key = `${p.threadId}:${item?.id ?? p.itemId}`;
    if (method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      const text = method === "item/agentMessage/delta";
      (text ? this.textDeltas : this.thinkingDeltas).add(key);
      if (p.delta) push({ kind: text ? "text" : "thinking", text: p.delta });
    } else if (method === "item/plan/delta") {
      if (p.delta) push({ kind: "thinking", text: p.delta });
    } else if (method === "item/started") {
      // 子线程写到的位置同样算这个任务的，直接放在顶层（不包进子智能体活动，见 tool-writes.ts）。
      if (item?.type === "commandExecution") {
        push({ kind: "tool", name: "exec", detail: short(item.command) });
        const cwd = codexCommandCwd(item);
        if (cwd) out.push(cwd);
      } else if (item?.type === "fileChange") {
        push({ kind: "tool", name: "edit", detail: short(item.changes) });
        const writes = codexChangeWrites(item);
        if (writes) out.push(writes);
      }
      else if (item?.type === "mcpToolCall") push({ kind: "tool", name: `${item.server}/${item.tool}`, detail: short(item.arguments) });
      else if (item?.type === "dynamicToolCall") push({ kind: "tool", name: item.tool, detail: short(item.arguments) });
      else if (item?.type === "webSearch") push({ kind: "tool", name: "WebSearch", detail: short(item.query ?? item.action) });
      else if (item?.type === "imageGeneration") push({ kind: "tool", name: "image_gen", detail: short(item.revisedPrompt) });
    } else if (method === "item/completed") {
      if (item?.type === "agentMessage") {
        push({ kind: "text", text: this.textDeltas.delete(key) ? "\n\n" : `${item.text ?? ""}\n\n` });
      } else if (item?.type === "reasoning") {
        const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n");
        if (this.thinkingDeltas.delete(key)) push({ kind: "thinking", text: "\n\n" });
        else if (text) push({ kind: "thinking", text: `${text}\n\n` });
      } else if (item?.type === "commandExecution" && (item.aggregatedOutput || item.exitCode != null)) {
        push({ kind: "tool", name: "exec 结果", detail: short(`退出码：${item.exitCode ?? "未知"}\n${item.aggregatedOutput ?? ""}`) });
      } else if (item?.type === "mcpToolCall" || item?.type === "dynamicToolCall") {
        const result = item.error ?? item.result ?? item.contentItems;
        if (result != null) push({ kind: "tool", name: `${item.tool} 结果`, detail: short(result) });
      }
    } else if (method === "error") {
      // 跟主线程同一份判据(codex-error-event.ts):重试中抬成 level:"notice"。从前这里不看
      // `willRetry`、一律裸 error —— 一场重连风暴在子智能体抽屉里就是几百条红色「执行异常」,
      // 而它只是在重试。
      //
      // 注意这一层**只改抽屉里的渲染和语义,不改父回合的成败**:下面那个 `push` 会把它包进
      // `childActivity`(恒为 `kind:"tool"`),所以它既不会写主时间线的红色诊断块、也不会置
      // `sawExecutionError` —— 子线程在重试不等于父回合有执行故障,这是刻意的。真正要穿过
      // 这层包装去判的只有回合级停滞看门狗(../turn-stall.ts 的 errorFacts):包装不是进展。
      const reported = codexErrorEvent(p);
      if (reported) push(reported.event);
    } else if (method === "turn/completed" && p.turn?.error?.message) {
      push({ kind: "error", message: p.turn.error.message });
    }
    return out;
  }
}

export class ClaudeChildActivity {
  private streamed = new Map<string, Set<string>>();
  private tools = new Map<string, string>();

  message(ev: any): AgentEvent[] {
    const id = ev.parent_tool_use_id;
    if (!id) return [];
    const out: AgentEvent[] = [];
    const push = (event: NativeAgentActivity) => out.push(childActivity(id, event));
    // **子线程里的重试也得报出来。** 带 `parent_tool_use_id` 的事件在 claude-stream 那边提前
    // return,不走它的 `system` 分支 —— 少了这一处,一个子智能体连不上上游的回合在 ash 眼里
    // 全程静默:看门狗一条错误都收不到,报警与熔断都无从谈起(第 2 轮审查 F1 的同类缺口;
    // codex 那一侧的同一个洞是第 1 轮第 1 条)。措辞与主线程共用一处,见那个文件。
    if (isClaudeRetry(ev)) {
      push({ kind: "error", message: claudeRetryMessage(ev), level: "notice" });
    } else if (ev.type === "stream_event") {
      const stream = ev.event;
      if (stream?.type === "message_start") this.streamed.delete(id);
      const delta = stream?.delta;
      if (stream?.type === "content_block_delta" && ["text_delta", "thinking_delta"].includes(delta?.type)) {
        const kind = delta.type === "text_delta" ? "text" : "thinking";
        const text = delta.text ?? delta.thinking;
        if (text) {
          const kinds = this.streamed.get(id) ?? new Set<string>();
          kinds.add(kind);
          this.streamed.set(id, kinds);
          push({ kind, text });
        }
      }
    } else if (ev.type === "assistant") {
      const streamed = this.streamed.get(id);
      for (const block of Array.isArray(ev.message?.content) ? ev.message.content : []) {
        if (block.type === "text" || block.type === "thinking") {
          const text = block.text ?? block.thinking;
          if (text && !streamed?.has(block.type)) push({ kind: block.type, text });
        } else if (block.type === "tool_use") {
          this.tools.set(`${id}:${block.id}`, block.name);
          push({ kind: "tool", name: block.name, detail: short(block.input) });
        }
      }
      if (ev.message?.content?.some((block: any) => block.type === "text")) push({ kind: "text", text: "\n\n" });
      this.streamed.delete(id);
    } else if (ev.type === "user") {
      for (const block of Array.isArray(ev.message?.content) ? ev.message.content : []) {
        if (block.type !== "tool_result") continue;
        const key = `${id}:${block.tool_use_id}`;
        const name = this.tools.get(key) ?? "工具";
        this.tools.delete(key);
        const result = Array.isArray(block.content)
          ? block.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")
          : block.content;
        if (block.is_error) push({ kind: "error", message: short(result) });
        else if (result) push({ kind: "tool", name: `${name} 结果`, detail: short(result) });
      }
    }
    return out;
  }
}
