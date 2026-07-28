import type { AgentEvent, AgentType } from "@harness/shared";
import type { LogLine } from "./TaskDetail";

// SSE 上的 agent 事件 → 会话气泡行。纯映射，没有状态，所以单独放一处：App 只管把
// 结果塞进 logs,TaskDetail / TeamFeed 只管渲染。
export function renderEvent(e: AgentEvent, agent?: AgentType, sessionId?: string): LogLine | null {
  const base = (l: LogLine): LogLine => ({ ...l, agent, sessionId });
  switch (e.kind) {
    case "text":
      return base({ kind: "text", text: e.text });
    case "thinking":
      return base({ kind: "thinking", text: e.text });
    case "system":
      return base({ kind: "system", text: e.text, at: new Date().toISOString() });
    case "tool":
      return base({ kind: "tool", name: e.name, text: e.detail ?? "" });
    case "error":
      return base({ kind: "error", text: e.message });
    case "done":
      return base({ kind: "done", text: `— 结束 (exit ${e.exitStatus}) —` });
    default:
      return null;
  }
}
