import type { AgentEvent, NativeAgentActivity } from "@ash/shared";

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
      if (item?.type === "commandExecution") push({ kind: "tool", name: "exec", detail: short(item.command) });
      else if (item?.type === "fileChange") push({ kind: "tool", name: "edit", detail: short(item.changes) });
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
    } else if (method === "error" && p.error?.message) {
      push({ kind: "error", message: p.error.message });
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
    if (ev.type === "stream_event") {
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
