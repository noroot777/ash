// REST client — the single-task subset of the harness web api (web/src/api.ts),
// re-pointed at a configurable base URL. RN's fetch is a native client (no
// browser CORS), so it talks straight to the backend over Tailscale.
import type {
  ProjectView,
  Task,
  Session,
  AgentExecutorProfile,
  AgentType,
  Schedule,
  ScheduledMessage,
  Group,
  GroupMode,
} from "@harness/shared";
import { getBaseURL } from "./config";

export type DetectedAgent = {
  type: AgentType;
  bin: string;
  available: boolean;
  path: string | null;
  version: string | null;
  resident: boolean;
};

export type CuaProcess = {
  pid: number;
  ppid: number;
  command: string;
};

export type CuaResidualStatus = {
  scopeId: string;
  scopeType: "task" | "team";
  checkedAt: string;
  detected: boolean;
  servicePath: string;
  processes: CuaProcess[];
  message: string;
  sideEffect: string;
};

export type TeamCuaStatus = {
  taskId: string;
  current: CuaResidualStatus;
  last: CuaResidualStatus | null;
};

export type TeamCuaKillResult = {
  killed: CuaProcess[];
  before: CuaProcess[];
  after: CuaProcess[];
  status: CuaResidualStatus;
  warning: string;
};

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
  deleteTask: (id: string): Promise<{ deleted: true; worktreeHint?: { path: string; branch: string } | null }> =>
    req(`/tasks/${id}`, { method: "DELETE" }).then(j),
  // Local branches + current HEAD for the new-task form's base picker.
  projectBranches: (id: string): Promise<{ branches: string[]; current: string | null }> =>
    req(`/projects/${id}/branches`).then(j),
  // One-click cleanup for a harness-managed worktree (post-delete).
  removeWorktree: (projectId: string, path: string, force = false): Promise<{ removed: true }> =>
    req(`/projects/${projectId}/worktrees/remove`, { method: "POST", body: JSON.stringify({ path, force }) }).then(j),
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
  // ask_question 的专用答复通道：清空待答问题并恢复同一个 CLI 会话。
  answer: (id: string, answer: string): Promise<{ answered: true; resumed: true }> =>
    req(`/tasks/${id}/answer`, { method: "POST", body: JSON.stringify({ answer }) }).then(j),
  // 团队停止会杀掉调度台常驻进程，并暂停它拥有的内部组；恢复沿用 runGroup。
  teamHalt: (id: string): Promise<{ halted: true }> =>
    req(`/tasks/${id}/team/halt`, { method: "POST" }).then(j),
  teamCuaStatus: (id: string): Promise<TeamCuaStatus> =>
    req(`/tasks/${id}/team/cua-status`).then(j),
  killTeamCua: (id: string): Promise<TeamCuaKillResult> =>
    req(`/tasks/${id}/team/kill-cua`, { method: "POST" }).then(j),

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

  // —— 分组(并行/串行批次):列表/增删改 + 整组运行/暂停。group 无 archived,删除只解绑成员。
  groups: (projectId?: string): Promise<Group[]> =>
    req(`/groups${projectId ? `?projectId=${projectId}` : ""}`).then(j),
  createGroup: (b: { name: string; mode?: GroupMode; projectId: string }): Promise<Group> =>
    req("/groups", { method: "POST", body: JSON.stringify(b) }).then(j),
  patchGroup: (id: string, patch: Partial<Pick<Group, "name" | "mode">>): Promise<Group> =>
    req(`/groups/${id}`, { method: "PATCH", body: JSON.stringify(patch) }).then(j),
  deleteGroup: (id: string): Promise<unknown> => req(`/groups/${id}`, { method: "DELETE" }).then(j),
  runGroup: (id: string): Promise<unknown> => req(`/groups/${id}/run`, { method: "POST" }).then(j),
  pauseGroup: (id: string): Promise<Group> => req(`/groups/${id}/pause`, { method: "POST" }).then(j),

  agents: (): Promise<AgentExecutorProfile[]> => req("/agents").then(j),
  detectAgents: (): Promise<DetectedAgent[]> => req("/agents/detect").then(j),
};
