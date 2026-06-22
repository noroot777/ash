// REST client — the single-task subset of the harness web api (web/src/api.ts),
// re-pointed at a configurable base URL. RN's fetch is a native client (no
// browser CORS), so it talks straight to the backend over Tailscale.
import type { ProjectView, Task, Session, AgentExecutorProfile, AgentType, Schedule, ScheduledMessage } from "@harness/shared";
import { getBaseURL } from "./config";

function base(): string {
  const b = getBaseURL();
  if (!b) throw new Error("未配置后端地址");
  return b;
}

const j = async (r: Response) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};

const req = (path: string, init?: RequestInit) =>
  fetch(`${base()}/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

export const api = {
  // Connectivity probe — used by the settings screen BEFORE a URL is saved, so it
  // takes an explicit url and bypasses the cached base().
  health: (url?: string): Promise<{ ok: boolean; ts: string }> =>
    fetch(`${(url ?? base()).replace(/\/+$/, "")}/api/health`).then(j),

  projects: (): Promise<ProjectView[]> => req("/projects").then(j),
  createProject: (b: { name: string; repoPath?: string }): Promise<ProjectView> =>
    req("/projects", { method: "POST", body: JSON.stringify(b) }).then(j),

  tasks: (): Promise<Task[]> => req("/tasks").then(j),
  task: (id: string): Promise<Task> => req(`/tasks/${id}`).then(j),
  createTask: (t: Partial<Task> & { projectId: string; title: string }): Promise<Task> =>
    req("/tasks", { method: "POST", body: JSON.stringify(t) }).then(j),
  patchTask: (id: string, patch: Partial<Task>): Promise<Task> =>
    req(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }).then(j),
  deleteTask: (id: string): Promise<unknown> => req(`/tasks/${id}`, { method: "DELETE" }).then(j),
  // 归档/取消归档:server 仅允许归档 done/failed/canceled(canArchive),归档态只读(拒编辑/运行/回复)。
  archiveTask: (id: string): Promise<Task> => req(`/tasks/${id}/archive`, { method: "POST" }).then(j),
  unarchiveTask: (id: string): Promise<Task> => req(`/tasks/${id}/unarchive`, { method: "POST" }).then(j),

  runTask: (id: string): Promise<unknown> => req(`/tasks/${id}/run`, { method: "POST" }).then(j),
  stopTask: (id: string): Promise<unknown> => req(`/tasks/${id}/stop`, { method: "POST" }).then(j),
  retryTask: (id: string): Promise<unknown> => req(`/tasks/${id}/retry`, { method: "POST" }).then(j),
  // reply 带 sendAt 时后端返回 202 { scheduled, message }（排成待发）；否则 { started }。
  replyTask: (
    id: string,
    text: string,
    opts?: { agent?: AgentType; sendAt?: string },
  ): Promise<{ started?: boolean; scheduled?: boolean; message?: ScheduledMessage }> =>
    req(`/tasks/${id}/reply`, { method: "POST", body: JSON.stringify({ text, ...opts }) }).then(j),

  // —— 定时（启动时机 once/cron，挂在 task 上）——
  schedule: (taskId: string): Promise<Schedule | null> => req(`/tasks/${taskId}/schedule`).then(j),
  setSchedule: (
    taskId: string,
    s: { kind: "once" | "cron"; at?: string | null; cron?: string | null },
  ): Promise<Schedule> =>
    req(`/tasks/${taskId}/schedule`, { method: "PUT", body: JSON.stringify(s) }).then(j),
  clearSchedule: (taskId: string): Promise<unknown> =>
    req(`/tasks/${taskId}/schedule`, { method: "DELETE" }).then(j),

  // —— 定时发送（约定时间投递一条回复；到点由调度器认领）——
  scheduledMessages: (taskId: string): Promise<ScheduledMessage[]> =>
    req(`/tasks/${taskId}/scheduled-messages`).then(j),
  cancelScheduledMessage: (mid: string): Promise<unknown> =>
    req(`/scheduled-messages/${mid}`, { method: "DELETE" }).then(j),

  sessions: (taskId: string): Promise<Session[]> => req(`/tasks/${taskId}/sessions`).then(j),
  sessionOutput: (id: string): Promise<string> => req(`/sessions/${id}/output`).then((r) => r.text()),

  agents: (): Promise<AgentExecutorProfile[]> => req("/agents").then(j),
};
