import type { AgentEvent, NativeWorkEvent, NativeWorkStatus } from "@ash/shared";
import { nativeWorkStatus as nativeStatus } from "@ash/shared/native-work";
import { ClaudeChildActivity, childActivity } from "./native-agent-activity.js";

const names = new Set(["agent", "task", "taskcreate", "taskupdate", "taskget", "tasklist", "taskoutput", "taskstop", "todowrite", "update_plan",
  "spawn_agent", "wait", "wait_agent", "send_input", "send_message", "close_agent", "resume_agent", "followup_task", "interrupt_agent", "list_agents"]);
export const nativeToolName = (name: string) => name.split(/[./]/).at(-1)!.toLowerCase();
const text = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value ?? "");
const clip = (value: unknown) => { const raw = text(value); return raw.length > 32_000 ? `${raw.slice(0, 32_000)}\n…（内容已截断）` : raw; };
const event = (name: string, nativeWork: NativeWorkEvent): AgentEvent => ({ kind: "tool", name, nativeWork: { at: new Date().toISOString(), ...nativeWork },
  detail: (nativeWork.type === "result" ? nativeWork.result : nativeWork.type === "agent" ? nativeWork.result || nativeWork.message || nativeWork.title || nativeWork.status : "").slice(0, 1500) || undefined,
});

export class NativeWorkTrace {
  private childActivity = new ClaudeChildActivity();
  private calls = new Map<string, string>();
  private taskCalls = new Map<string, string>();
  private agentCalls = new Set<string>();
  private progressAgents = new Set<string>();
  private workflows = new ClaudeWorkflowWork();
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
      if (this.workflows.owns(ev)) return [...out, ...this.workflows.message(ev)];
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
    if (ev.type === "stream_event" && ev.event?.type === "message_start") {
      const model = nativeAgentModel(parentId, ev.event.message?.model);
      if (model) out.push(model);
    }
    // Nested assistant messages have their own usage and text; these belong to the child.
    if (ev.type === "assistant") {
      const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
      const message = content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
      const model = typeof ev.message?.model === "string" && ev.message.model !== "<synthetic>" ? ev.message.model.trim() : "";
      // messageId 与 codex 的 item.id 同义:两条不同的完整消息哪怕后一条以前一条开头,也是
      // 两份独立快照,图片账据此换代重拍(shared NativeWorkEvent.messageId 的注释)。
      const messageId = typeof ev.message?.id === "string" && ev.message.id ? { messageId: ev.message.id } : {};
      if (message || model) out.push(event("Agent", { type: "agent", id: parentId, status: "running",
        ...(message ? { message: clip(message) } : {}), ...messageId, ...(model ? { model } : {}),
      }));
      for (const block of content) {
        if (block.type !== "tool_use") continue;
        const call = this.call(block.name, block.input, block.id, parentId);
        if (call) out.push(call);
        else if (!this.progressAgents.has(parentId)) out.push(event("Agent", { type: "agent", id: parentId, status: "running", ...messageId, message: `${block.name} · ${clip(block.input).slice(0, 1500)}` }));
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

/**
 * Workflow 工具起的子智能体。
 *
 * 它们跟 Agent 工具派的不是一路：整个工作流只有**一个** `local_workflow` 后台任务（一个
 * task_id），里面的子智能体既没有自己的 `task_started`，正文也不带 `parent_tool_use_id`
 * 回流到主会话的流里（各自的记录只落在 `~/.claude/projects/…/subagents/workflows/<runId>/`）。
 * 流里唯一能看到它们的地方是这个任务 `task_progress` 上的 `workflow_progress` 快照：每个
 * `workflow_agent` 一条（index / label / phaseTitle / agentId / model / state /
 * lastToolName / resultPreview …），每份快照带的是全量列表，CLI 节流着发、不是每条都带。
 *
 * 行的身份用「工作流调用 + index」而不是 agentId：排队时还没分到 agentId（state=start 且没有
 * startedAt），同一行后来才补上。快照是全量重发的，只在内容变了时才产出事件，免得把执行记录刷爆。
 */
class ClaudeWorkflowWork {
  private runs = new Map<string, Map<string, string>>();
  private tools = new Map<string, string>();

  owns(ev: any): boolean {
    return ev.task_type === "local_workflow" || Array.isArray(ev.workflow_progress) || this.runs.has(ev.task_id);
  }

  message(ev: any): AgentEvent[] {
    const run = String(ev.tool_use_id || ev.task_id || "workflow");
    const seen = this.runs.get(ev.task_id) ?? new Map<string, string>();
    this.runs.set(ev.task_id, seen);
    const out: AgentEvent[] = [];
    for (const entry of Array.isArray(ev.workflow_progress) ? ev.workflow_progress : []) {
      if (entry?.type !== "workflow_agent" || entry.index == null) continue;
      const id = `${run}:workflow-agent:${entry.index}`;
      const label = typeof entry.label === "string" ? entry.label : `#${entry.index}`;
      const failure = entry.state === "error" && typeof entry.error === "string" ? entry.error : "";
      const work: NativeWorkEvent = {
        type: "agent", id, status: workflowAgentStatus(entry),
        title: typeof entry.phaseTitle === "string" && entry.phaseTitle ? `${entry.phaseTitle} · ${label}` : label,
        ...(typeof entry.agentId === "string" ? { nativeId: entry.agentId } : {}),
        ...(typeof entry.model === "string" ? { model: entry.model } : {}),
        ...(typeof entry.agentType === "string" ? { agentType: entry.agentType } : {}),
        ...(typeof entry.promptPreview === "string" ? { description: entry.promptPreview } : {}),
        ...(typeof entry.resultPreview === "string" || failure ? { result: clip(entry.resultPreview ?? failure) } : {}),
      };
      const signature = JSON.stringify(work);
      if (seen.get(id) !== signature) { seen.set(id, signature); out.push(event("Agent", work)); }
      const tool = typeof entry.lastToolName === "string" ? `${entry.lastToolName}\u0000${entry.lastToolSummary ?? ""}` : "";
      if (tool && this.tools.get(id) !== tool) {
        this.tools.set(id, tool);
        out.push(childActivity(id, { kind: "tool", name: entry.lastToolName, ...(entry.lastToolSummary ? { detail: String(entry.lastToolSummary).slice(0, 1500) } : {}) }));
      }
    }
    // 工作流整体收工却没走完的那几个：它没有逐个报终态，只能按整体的结局记成停了。
    if (ev.subtype === "task_notification" && nativeStatus(ev.status) !== "completed") {
      for (const [id, signature] of seen) {
        const row = JSON.parse(signature) as NativeWorkEvent & { type: "agent" };
        if (row.status !== "running" && row.status !== "pending") continue;
        const stopped = { ...row, status: "stopped" as const };
        seen.set(id, JSON.stringify(stopped));
        out.push(event("Agent", stopped));
      }
    }
    return out;
  }
}

/** `workflow_agent.state` 的取值见 claude CLI：start（没有 startedAt = 还在排队）/ progress / done / error / interrupt …。 */
function workflowAgentStatus(entry: any): NativeWorkStatus {
  if (entry.state === "start") return entry.startedAt ? "running" : "pending";
  if (entry.state === "done") return "completed";
  if (entry.state === "error") return entry.skipped ? "stopped" : "failed";
  if (entry.state === "interrupt") return "stopped";
  return typeof entry.state === "string" ? "running" : "unknown";
}

export function nativePlanSnapshot(id: string, plan: unknown, explanation?: string): AgentEvent {
  return event("update_plan", { type: "call", id, name: "update_plan", input: { plan, explanation } });
}

export function nativeAgentModel(id: string, model: unknown): AgentEvent | null {
  return nativeAgentProfile(id, { model });
}

/**
 * 子智能体的「身份」：实跑模型、智能水平、名字。
 *
 * codex 的 `thread/read` 一次就把三样都给了（`model` / `reasoningEffort` / `source.subAgent`），
 * 所以别再为某一样单开一条通道 —— 2026-09-12 之前这里只取了 model，界面上的智能水平一直空着。
 */
export function nativeAgentProfile(id: string, fields: { model?: unknown; effort?: unknown; title?: unknown }): AgentEvent | null {
  const clean = (value: unknown) => typeof value === "string" && value.trim() && value !== "<synthetic>" ? value.trim() : "";
  const model = clean(fields.model);
  const effort = clean(fields.effort);
  const title = clean(fields.title);
  if (!model && !effort && !title) return null;
  return event("Agent", { type: "agent", id, status: "unknown",
    ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(title ? { title } : {}) });
}

export function codexNativeWork(item: any): AgentEvent[] {
  const type = String(item?.type ?? "").replace(/_/g, "").toLowerCase();
  if (type === "todolist") return [event("TodoWrite", {
    type: "call", id: item.id, name: "TodoWrite", input: { todos: (item.items ?? []).map((row: any) => ({ content: row.text, status: row.completed ? "completed" : "pending" })) },
  })];
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
      ...(tool === "spawnagent" ? { description: item.prompt, title: item.prompt?.split("\n")[0]?.slice(0, 120),
        requestedModel: item.model, requestedEffort: item.reasoningEffort ?? item.reasoning_effort, agentType: item.agentType ?? item.agent_type } : {}),
      ...(state?.message ? closed || status === "completed" || status === "failed" ? { result: clip(state.message) } : { message: clip(state.message) } : {}),
      // 快照身份 = 这一次调用:两次 wait 报回同一段文字也是两份独立快照,图片账据此换代
      // 重拍(审查第 1 轮 R1 实证 A:同文第二张图不再保存)。
      ...(state?.message && item.id != null ? { messageId: String(item.id) } : {}),
    });
  });
}

/**
 * codex 0.153+ 的派活通道：`subAgentActivity`。
 *
 * 这条协议**不带派活正文** —— `spawn_agent` 的 `message` 参数在上游就被整段加密
 * （`gAAAAA…`），父子两边的 rollout 里都只有密文，codex CLI 自己也只转发不解密。所以
 * 「主会话对子智能体说了什么」ash 在任何通道都拿不到，只有 `agentPath` 这一个明文标签。
 * 别再去 rollout 里找正文（2026-09-12 已查遍父/子两份记录与事件流）。
 *
 * `interacted` 故意不产出事件：它既不是开工也不是收工，拿它改状态会把已完成的子智能体
 * 重新翻成「进行中」，而且一次派活能刷出上百条。
 */
export function codexSubAgentWork(method: string, params: any, rootThreadId?: string): AgentEvent[] {
  const item = params?.item;
  if (method !== "item/started" || item?.type !== "subAgentActivity") return [];
  const id = typeof item.agentThreadId === "string" ? item.agentThreadId : "";
  // 子智能体反过来找主会话（agentPath `/root`）不是一条新工作。
  if (!id || id === rootThreadId) return [];
  const path = typeof item.agentPath === "string" ? item.agentPath : "";
  const name = path.split("/").filter(Boolean).at(-1) ?? "";
  const sender = typeof params.threadId === "string" && params.threadId !== rootThreadId ? params.threadId : undefined;
  if (item.kind === "started") {
    // call 事件:既在主会话执行过程里留下一行「派出了谁」,也让侧栏那行有真名字而不是一截线程 id。
    return [{ ...event("spawn_agent", { type: "call", id, parentId: sender, name: "spawn_agent",
      input: { name, agent_path: path, thread_id: id } }), detail: name || path || undefined } as AgentEvent];
  }
  if (item.kind === "completed" || item.kind === "interrupted") {
    return [event("Agent", { type: "agent", id, nativeId: id, parentId: sender,
      status: item.kind === "completed" ? "completed" : "stopped", ...(name ? { title: name } : {}) })];
  }
  return [];
}

export function codexChildWork(method: string, params: any): AgentEvent[] {
  const item = params.item;
  const out = codexNativeWork(item);
  if (method === "turn/started") out.push(event("Agent", {
    type: "agent", id: params.threadId, nativeId: params.threadId, status: "running", result: "", message: "",
  }));
  if (method === "item/completed" && item?.type === "agentMessage") out.push(event("Agent", {
    type: "agent", id: params.threadId, nativeId: params.threadId, status: "running", message: clip(item.text ?? ""),
    // 每条完成的消息是独立快照:身份随事件带走,图片账按它换代(文字前缀不算同一份正文)。
    ...(item.id != null ? { messageId: String(item.id) } : {}),
  }));
  if (method === "turn/completed") out.push(event("Agent", {
    type: "agent", id: params.threadId, nativeId: params.threadId, status: nativeStatus(params.turn?.status),
    ...(params.turn?.error?.message ? { result: clip(params.turn.error.message) } : {}),
  }));
  return out;
}
