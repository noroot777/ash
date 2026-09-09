import type { AgentEvent, NativeWorkEvent } from "@ash/shared";
import { nativeWorkStatus as nativeStatus } from "@ash/shared/native-work";
import { ClaudeChildActivity } from "./native-agent-activity.js";

const names = new Set(["agent", "task", "taskcreate", "taskupdate", "taskget", "tasklist", "taskoutput", "taskstop", "todowrite", "update_plan",
  "spawn_agent", "wait", "wait_agent", "send_input", "send_message", "close_agent", "resume_agent", "followup_task", "interrupt_agent", "list_agents"]);
export const nativeToolName = (name: string) => name.split(/[./]/).at(-1)!.toLowerCase();
const text = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value ?? "");
const clip = (value: unknown) => { const raw = text(value); return raw.length > 32_000 ? `${raw.slice(0, 32_000)}\n…（内容已截断）` : raw; };
const event = (name: string, nativeWork: NativeWorkEvent): AgentEvent => ({ kind: "tool", name, nativeWork,
  detail: (nativeWork.type === "result" ? nativeWork.result : nativeWork.type === "agent" ? nativeWork.result || nativeWork.message || nativeWork.title || nativeWork.status : "").slice(0, 1500) || undefined,
});

export class NativeWorkTrace {
  private childActivity = new ClaudeChildActivity();
  private calls = new Map<string, string>();
  private taskCalls = new Map<string, string>();
  private agentCalls = new Set<string>();
  private progressAgents = new Set<string>();
  private serial = 0;

  call(name: string, input: unknown, id?: string, parentId?: string): AgentEvent | null {
    if (typeof name !== "string" || !names.has(nativeToolName(name))) return null;
    const callId = id || `native-${++this.serial}`;
    this.calls.set(callId, name);
    if (["agent", "task"].includes(nativeToolName(name))) this.agentCalls.add(callId);
    let parsed = input;
    if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { parsed = { message: parsed }; } }
    const fields = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    const inputFields = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === "string" ? clip(value) : value]));
    return { ...event(name, { type: "call", id: callId, parentId, name, input: inputFields }), detail: text(fields).slice(0, 1500) } as AgentEvent;
  }

  result(id: string, result: unknown, failed = false): AgentEvent | null {
    const name = this.calls.get(id);
    if (!name) return null;
    this.calls.delete(id);
    const rendered = Array.isArray(result)
      ? result.filter((block) => block?.type === "text").map((block) => block.text).join("\n")
      : result;
    return event(name, { type: "result", id, result: clip(rendered), failed });
  }

  claudeMessage(ev: any): AgentEvent[] {
    const out: AgentEvent[] = this.childActivity.message(ev);
    if (ev.type === "system" && /^task_(started|progress|notification)$/.test(ev.subtype)) {
      const knownAgent = this.agentCalls.has(ev.tool_use_id) || this.taskCalls.has(ev.task_id);
      const agentType = ev.task_type === "local_agent" || ev.task_type === "remote_agent";
      if (ev.task_type === "local_bash" || (!agentType && !knownAgent)) return out;
      if (ev.tool_use_id && ev.task_id) this.taskCalls.set(ev.task_id, ev.tool_use_id);
      const id = ev.tool_use_id || this.taskCalls.get(ev.task_id) || ev.task_id;
      if (id && ev.subtype === "task_progress") this.progressAgents.add(id);
      if (id) out.push(event("Agent", {
        type: "agent", id, nativeId: ev.task_id,
        ...(ev.subtype === "task_started" ? { title: ev.description } : {}),
        status: ev.subtype === "task_notification" ? nativeStatus(ev.status) : "running",
        ...(ev.subtype === "task_notification" ? { result: clip(ev.summary ?? "") } : ev.subtype === "task_progress" ? { message: clip(ev.description || ev.last_tool_name || "") } : {}),
      }));
    }
    const parentId = ev.parent_tool_use_id;
    if (!parentId) return out;
    // Nested assistant messages have their own usage and text; these belong to the child.
    if (ev.type === "assistant") {
      const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
      const message = content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
      if (message) out.push(event("Agent", { type: "agent", id: parentId, status: "running", message: clip(message) }));
      for (const block of content) {
        if (block.type !== "tool_use") continue;
        const call = this.call(block.name, block.input, block.id, parentId);
        if (call) out.push(call);
        else if (!this.progressAgents.has(parentId)) out.push(event("Agent", { type: "agent", id: parentId, status: "running", message: `${block.name} · ${clip(block.input).slice(0, 1500)}` }));
      }
    } else if (ev.type === "user" && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content) {
        if (block.type !== "tool_result") continue;
        const result = this.result(block.tool_use_id, block.content, block.is_error === true);
        if (result) out.push(result);
      }
    }
    return out;
  }
}

export function nativePlanSnapshot(id: string, plan: unknown, explanation?: string): AgentEvent {
  return event("update_plan", { type: "call", id, name: "update_plan", input: { plan, explanation } });
}

export function codexNativeWork(item: any): AgentEvent[] {
  const type = String(item?.type ?? "").replace(/_/g, "").toLowerCase();
  if (type === "todolist") return [{ kind: "tool", name: "TodoWrite", nativeWork: {
    type: "call", id: item.id, name: "TodoWrite", input: { todos: (item.items ?? []).map((row: any) => ({ content: row.text, status: row.completed ? "completed" : "pending" })) },
  } }];
  if (!["collabtoolcall", "collabagenttoolcall"].includes(type)) return [];
  const tool = String(item.tool ?? "").replace(/_/g, "").toLowerCase();
  const ids: string[] = item.receiverThreadIds ?? item.receiver_thread_ids ?? [];
  const states = item.agentsStates ?? item.agents_states ?? item.statuses ?? {};
  const receivers = ids.length ? ids : Object.keys(states);
  return receivers.map((id) => {
    const state = states[id];
    let status = nativeStatus(state?.status ?? state);
    // Completion of spawn/wait is the tool's status, not proof the child finished.
    if (status === "unknown" && tool === "spawnagent") status = nativeStatus(item.status) === "failed" ? "failed" : "running";
    const closed = tool === "closeagent" && nativeStatus(item.status) === "completed";
    if (closed && status !== "completed" && status !== "failed") status = "stopped";
    return event(item.tool ?? "Agent", {
      type: "agent", id, nativeId: id, status, closed, parentId: item.senderThreadId ?? item.sender_thread_id,
      ...(tool === "spawnagent" ? { description: item.prompt, title: item.prompt?.split("\n")[0]?.slice(0, 120), model: item.model, agentType: item.agentType ?? item.agent_type } : {}),
      ...(state?.message ? closed || status === "completed" || status === "failed" ? { result: clip(state.message) } : { message: clip(state.message) } : {}),
    });
  });
}

export function codexChildWork(method: string, params: any): AgentEvent[] {
  const item = params.item;
  const out = codexNativeWork(item);
  if (method === "turn/started") out.push(event("Agent", {
    type: "agent", id: params.threadId, nativeId: params.threadId, status: "running", result: "", message: "",
  }));
  if (method === "item/completed" && item?.type === "agentMessage") out.push(event("Agent", {
    type: "agent", id: params.threadId, nativeId: params.threadId, status: "running", message: clip(item.text ?? ""),
  }));
  if (method === "turn/completed") out.push(event("Agent", {
    type: "agent", id: params.threadId, nativeId: params.threadId, status: nativeStatus(params.turn?.status),
    ...(params.turn?.error?.message ? { result: clip(params.turn.error.message) } : {}),
  }));
  return out;
}
