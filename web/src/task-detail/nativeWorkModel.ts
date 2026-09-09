import type { NativeAgentActivity, NativeWorkEvent, NativeWorkStatus, TaskStatus } from "@ash/shared";
import { nativeWorkStatus as workStatus } from "@ash/shared/native-work";
export { nativeWorkStatus as workStatus } from "@ash/shared/native-work";
import type { ConversationItem } from "./conversationModel.ts";

export interface NativeWorkItem {
  id: string;
  kind: "agent" | "task";
  sessionId: string;
  sessionLabel: string;
  parentId?: string;
  nativeId?: string;
  title: string;
  description?: string;
  status: NativeWorkStatus;
  result?: string;
  message?: string;
  owner?: string;
  model?: string;
  sessionModel?: string;
  startedAt?: string;
  endedAt?: string;
  agentType?: string;
  legacy?: boolean;
  activity?: NativeAgentActivity[];
}

type Call = Extract<NativeWorkEvent, { type: "call" }>;
const str = (value: unknown): string => typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
const toolName = (name: string) => name.split(/[./]/).at(-1)!.toLowerCase();
const spawnTools = new Set(["agent", "task", "spawn_agent"]);
const legacyTools = new Set([...spawnTools, "taskcreate", "taskupdate", "todowrite", "update_plan"]);
const terminal = (status: NativeWorkStatus) => ["completed", "failed", "stopped"].includes(status);
function parse(raw: string): Record<string, any> {
  try { const value = JSON.parse(raw); return value && typeof value === "object" ? value : {}; } catch { return {}; }
}

function legacyInput(raw: string): Record<string, unknown> {
  const input = parse(raw);
  if (Object.keys(input).length) return input;
  // Old trace details were cut mid-JSON at 1,500 characters.
  for (const key of ["subject", "description", "prompt", "taskId", "status", "owner", "subagent_type", "model"]) {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw);
    if (match) { try { input[key] = JSON.parse(`"${match[1]}"`); } catch { /* incomplete field */ } }
  }
  return input;
}

export function buildNativeWork(items: ConversationItem[], taskStatus: TaskStatus): NativeWorkItem[] {
  const rows = new Map<string, NativeWorkItem>();
  const calls = new Map<string, { call: Call; rowId?: string }>();
  const taskIds = new Map<string, string>();
  const endedRows = new Set<string>();
  const legacyOrdinals = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "agent") continue;
    const key = (id: string) => `${item.sessionId}:${id}`;
    const base = { sessionId: item.sessionId, sessionLabel: item.label, sessionModel: item.run?.model || item.session?.model || undefined };
    let observedAt: string | undefined;
    const put = (id: string, patch: Partial<NativeWorkItem>) => {
      const previous = rows.get(id);
      const next = { id, kind: "agent" as const, title: `子智能体 ${id.slice(item.sessionId.length + 1, item.sessionId.length + 9)}`, status: "unknown" as const, ...base, ...previous, ...patch };
      if (observedAt) {
        if (!next.startedAt && (next.status === "running" || next.status === "pending")) next.startedAt = observedAt;
        if (terminal(next.status) && (!previous || !terminal(previous.status))) next.endedAt = observedAt;
      }
      if (!terminal(next.status)) delete next.endedAt;
      if (next.result && next.message === next.result) delete next.message;
      rows.set(id, next);
      if (item.endedAt) endedRows.add(id);
      else endedRows.delete(id);
      return next;
    };
    const taskKey = (parent: string | undefined, nativeId: string) => key(`${parent ?? "root"}:task:${nativeId}`);
    const applyTask = (call: Call, legacy: boolean) => {
      const input = call.input;
      const nativeId = str(input.taskId);
      if (!nativeId) return;
      const lookup = taskKey(call.parentId, nativeId);
      const id = taskIds.get(lookup) ?? lookup;
      taskIds.set(lookup, id);
      const status = workStatus(input.status);
      put(id, {
        kind: "task", nativeId, parentId: call.parentId ? key(call.parentId) : undefined,
        ...(!rows.has(id) ? { title: `内部任务 #${nativeId}` } : {}),
        ...(str(input.subject) ? { title: str(input.subject) } : {}),
        ...(str(input.description) ? { description: str(input.description) } : {}),
        ...(str(input.owner) ? { owner: str(input.owner) } : {}),
        ...(status !== "unknown" ? { status } : {}), legacy,
      });
    };
    let index = 0;
    for (const segment of item.segments) for (const trace of segment.events) {
      const fallbackId = `legacy:${item.id}:${index++}`;
      if (trace.kind !== "tool") continue;
      if (!trace.nativeWork && !legacyTools.has(toolName(trace.label))) continue;
      const legacy = !trace.nativeWork;
      const activity: NativeWorkEvent = trace.nativeWork ?? {
        type: "call", id: fallbackId, name: trace.label, input: legacyInput(trace.detail ?? ""),
      };
      const timestamp = activity.at ?? trace.at;
      observedAt = timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined;
      if (activity.type === "activity") {
        const id = key(activity.id);
        const row = rows.get(id) ?? put(id, { nativeId: activity.id, status: "running" });
        (row.activity ??= []).push(activity.event);
        continue;
      }
      if (activity.type === "agent") {
        const id = key(activity.id);
        const patch = Object.fromEntries(Object.entries(activity).filter(([, value]) => value !== undefined));
        delete patch.type;
        delete patch.id;
        delete patch.closed;
        delete patch.at;
        const previous = rows.get(id);
        if (activity.closed && (previous?.status === "completed" || previous?.status === "failed")) patch.status = previous.status;
        if (activity.status === "unknown" && rows.has(id)) delete patch.status;
        put(id, { ...patch, ...(activity.parentId ? { parentId: key(activity.parentId) } : {}) });
        continue;
      }
      if (activity.type === "call") {
        const name = toolName(activity.name);
        const input = activity.input;
        const id = key(activity.id);
        const parentId = activity.parentId ? key(activity.parentId) : undefined;
        if (name === "todowrite" || name === "update_plan") {
          const list = input.todos ?? input.plan;
          if (!Array.isArray(list)) continue;
          const prefix = key(`${activity.parentId ?? "root"}:plan:`);
          const previousPlan = new Map([...rows].filter(([rowId]) => rowId.startsWith(prefix)));
          for (const rowId of previousPlan.keys()) rows.delete(rowId);
          list.forEach((step, ordinal) => {
            if (!step || typeof step !== "object") return;
            const title = str(step.content ?? step.step);
            const rowId = `${prefix}${ordinal}`;
            const previous = previousPlan.get(rowId);
            if (previous?.title === title) rows.set(rowId, previous);
            if (title) put(rowId, { kind: "task", title, parentId, status: workStatus(step.status), description: str(input.explanation), legacy });
          });
          continue;
        }
        if (calls.has(id)) continue;
        calls.set(id, { call: activity });
        if (spawnTools.has(name)) {
          put(id, { kind: "agent", parentId, title: str(input.description ?? input.name ?? input.task_name) || str(input.prompt ?? input.message).split("\n")[0].slice(0, 100) || "子智能体",
            description: str(input.prompt ?? input.message), model: str(input.model), agentType: str(input.subagent_type ?? input.agent_type),
            status: legacy ? "unknown" : "running", ...(observedAt ? { startedAt: observedAt } : {}), legacy });
          calls.get(id)!.rowId = id;
        } else if (name === "taskcreate") {
          let nativeId: string | undefined;
          if (legacy) {
            const scope = taskKey(activity.parentId, "");
            const ordinal = (legacyOrdinals.get(scope) ?? 0) + 1;
            legacyOrdinals.set(scope, ordinal);
            nativeId = String(ordinal);
            taskIds.set(taskKey(activity.parentId, nativeId), id);
          }
          put(id, { kind: "task", nativeId, parentId, title: str(input.subject) || "内部任务", description: str(input.description), status: legacy ? "unknown" : "pending", legacy });
          calls.get(id)!.rowId = id;
        } else if (name === "taskupdate" && legacy) applyTask(activity, true);
        continue;
      }
      const saved = calls.get(key(activity.id));
      if (!saved) continue;
      const { call, rowId } = saved;
      const name = toolName(call.name);
      const response = parse(activity.result);
      if (name === "taskupdate") {
        if (!activity.failed) applyTask(call, false);
        continue;
      }
      if (rowId && name === "taskcreate") {
        const nativeId = str(response.task?.id ?? response.taskId ?? response.id) || /Task\s+#(\S+)\s+created/i.exec(activity.result)?.[1];
        if (nativeId) taskIds.set(taskKey(call.parentId, nativeId), rowId);
        put(rowId, { nativeId, status: activity.failed ? "failed" : "pending", ...(activity.failed ? { result: activity.result } : {}) });
      } else if (rowId && spawnTools.has(name)) {
        const nativeId = str(response.agent_id ?? response.agentId) || /agentId:\s*([\w-]+)/.exec(activity.result)?.[1];
        const background = call.input.run_in_background === true || name === "spawn_agent" || /agent launched.*(?:async|background)|Async agent launched/i.test(activity.result);
        put(rowId, { nativeId, status: activity.failed ? "failed" : background ? "running" : "completed", result: activity.result });
        if (nativeId && name === "spawn_agent") {
          const row = rows.get(rowId)!;
          rows.delete(rowId);
          const existing = rows.get(key(nativeId));
          rows.set(key(nativeId), { ...row, id: key(nativeId), ...(existing ? {
            activity: existing.activity, message: existing.message,
            model: existing.model || row.model,
            startedAt: [row.startedAt, existing.startedAt].filter((at): at is string => !!at).sort()[0],
            endedAt: existing.endedAt ?? row.endedAt,
            status: activity.failed ? "failed" : existing.status,
            result: activity.failed ? row.result : existing.result ?? row.result,
          } : {}) });
          if (endedRows.delete(rowId)) endedRows.add(key(nativeId));
        }
      } else if (!activity.failed) {
        if (name === "taskget" || name === "tasklist") {
          const tasks = response.tasks ?? (response.task ? [response.task] : response.id ? [response] : []);
          if (Array.isArray(tasks)) for (const task of tasks) {
            if (task && typeof task === "object") applyTask({ ...call, input: { ...task, taskId: task.id ?? task.taskId } }, false);
          }
        }
        if (name === "taskoutput" || name === "taskstop") {
          const nativeId = str(call.input.task_id ?? response.task?.task_id);
          const row = [...rows.values()].find((candidate) => candidate.sessionId === item.sessionId && candidate.kind === "agent" && candidate.nativeId === nativeId);
          const status = name === "taskstop" ? "stopped" : workStatus(response.task?.status ?? /<status>([^<]+)<\/status>/.exec(activity.result)?.[1]);
          if (row && status !== "unknown") put(row.id, { status, result: str(response.task?.output) || /<output>([\s\S]*?)<\/output>/.exec(activity.result)?.[1] || activity.result });
        }
        const states = response.status ?? response.statuses;
        if (states && typeof states === "object") for (const [nativeId, state] of Object.entries(states)) {
          const value = typeof state === "object" && state ? state as Record<string, unknown> : {};
          const status = workStatus(Object.keys(value)[0] ?? state);
          put(key(nativeId), { nativeId, status, result: str(value.completed ?? value.errored ?? value.error) });
        }
        if (name === "close_agent") {
          const id = key(str(call.input.id));
          const previous = rows.get(id);
          if (previous?.status !== "completed" && previous?.status !== "failed") put(id, { status: "stopped" });
        }
      }
    }
  }
  // Parent lifecycle cannot prove the final state of independently running children.
  return [...rows.values()].map((row) => {
    if (row.status !== "running" && row.status !== "pending") return row;
    if (taskStatus === "canceled" || taskStatus === "paused") return { ...row, status: "unknown", message: row.message || "主任务已停止或暂停，未收到此项最终状态。" };
    if ((taskStatus !== "running" && taskStatus !== "queued") || endedRows.has(row.id)) return { ...row, status: "unknown", message: row.message || "会话已结束，未收到此项最终状态。" };
    return row;
  });
}
