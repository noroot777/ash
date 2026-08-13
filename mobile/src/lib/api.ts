// REST client — the single-task subset of the harness web api (web/src/api.ts),
// re-pointed at a configurable base URL. RN's fetch is a native client (no
// browser CORS), so it talks straight to the backend over Tailscale.
import type {
  AppSettings,
  ProjectView,
  Task,
  Session,
  AgentExecutorProfile,
  AgentType,
  Schedule,
  ScheduledMessage,
  SkillList,
  Group,
  GroupMode,
  DuetSpeaker,
  GateName,
  LlmProvider,
  LlmProtocol,
  TaskWorkspaceLeftover,
  TaskWorkspaceDiscardResult,
} from "@harness/shared";
import type { CliModelCatalog } from "@harness/shared/cli-presets";
import { getBaseURL } from "./config";

// 删除任务的返回:`leftover` 是清理之后**仍然剩下**的 worktree/分支(没勾选、或勾
// 了但 git 拒绝),`cleanup` 是本次清理的逐项结果(没勾选时为 null)。
export type DeleteTaskResult = {
  deleted: true;
  leftover: TaskWorkspaceLeftover | null;
  cleanup: TaskWorkspaceDiscardResult | null;
};

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

export type DuetTranscriptTurn = {
  stop?: string; // 合稿轮的停止原因;consensus 之外都是未共识的决策文档
  type?: undefined;
  round: number;
  speaker: DuetSpeaker;
  text: string;
  raised?: boolean;
  agrees?: boolean;
  conclusion?: string;
  error?: string;
  at?: string;
  target?: "A" | "B";
};

export type DuetTranscriptGate = {
  type: "duet.gate";
  taskId: string;
  gate: GateName;
  open: boolean;
  consensus?: boolean;
  conclusionA?: string | null;
  conclusionB?: string | null;
};

export type DuetTranscriptEntry = DuetTranscriptTurn | DuetTranscriptGate;

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
  settings: (): Promise<AppSettings> => req("/settings").then(j),
  patchSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    req("/settings", { method: "PATCH", body: JSON.stringify(patch) }).then(j),

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
  // 删除任务。cleanup 里勾了什么就一起删什么(worktree 目录 / 分支);force 是看过
  // 第一次失败之后的再来一次(--force / -D)。
  deleteTask: (
    id: string,
    cleanup?: { worktree?: boolean; branch?: boolean; force?: boolean },
  ): Promise<DeleteTaskResult> => {
    const q = new URLSearchParams();
    if (cleanup?.worktree) q.set("worktree", "1");
    if (cleanup?.branch) q.set("branch", "1");
    if (cleanup?.force) q.set("force", "1");
    const qs = q.toString();
    return req(`/tasks/${id}${qs ? `?${qs}` : ""}`, { method: "DELETE" }).then(j);
  },
  // 删除前先问「这个任务还留着 worktree/分支吗」,有才提示要不要一起删。
  taskWorkspace: (id: string): Promise<TaskWorkspaceLeftover> => req(`/tasks/${id}/workspace`).then(j),
  // Local branches + current HEAD for the new-task form's base picker.
  projectBranches: (id: string): Promise<{ branches: string[]; current: string | null }> =>
    req(`/projects/${id}/branches`).then(j),
  // 清理某个任务残留的 worktree 目录 / 分支(任务行这时通常已经删了,所以挂在 project 上)。
  discardTaskWorkspace: (
    projectId: string,
    body: { taskId: string; worktree?: boolean; branch?: boolean; force?: boolean },
  ): Promise<TaskWorkspaceDiscardResult> =>
    req(`/projects/${projectId}/workspaces/discard`, { method: "POST", body: JSON.stringify(body) }).then(j),
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
  duetTranscript: (taskId: string): Promise<DuetTranscriptEntry[]> => req(`/tasks/${taskId}/duet`).then(j),

  // —— 分组(并行/串行批次):列表/增删改 + 整组运行/暂停。group 无 archived,删除只解绑成员。
  groups: (projectId?: string): Promise<Group[]> =>
    req(`/groups${projectId ? `?projectId=${projectId}` : ""}`).then(j),
  // 普通 groups 列表刻意过滤团队内部组；团队详情必须按 ownerTaskId 单独拉取，
  // 才能可靠读取 paused 并提供「恢复全组」。
  groupsByOwnerTask: (ownerTaskId: string): Promise<Group[]> =>
    req(`/groups?ownerTaskId=${encodeURIComponent(ownerTaskId)}`).then(j),
  createGroup: (b: { name: string; mode?: GroupMode; projectId: string }): Promise<Group> =>
    req("/groups", { method: "POST", body: JSON.stringify(b) }).then(j),
  patchGroup: (id: string, patch: Partial<Pick<Group, "name" | "mode">>): Promise<Group> =>
    req(`/groups/${id}`, { method: "PATCH", body: JSON.stringify(patch) }).then(j),
  deleteGroup: (id: string): Promise<unknown> => req(`/groups/${id}`, { method: "DELETE" }).then(j),
  runGroup: (id: string): Promise<unknown> => req(`/groups/${id}/run`, { method: "POST" }).then(j),
  pauseGroup: (id: string): Promise<Group> => req(`/groups/${id}/pause`, { method: "POST" }).then(j),

  agents: (): Promise<AgentExecutorProfile[]> => req("/agents").then(j),
  detectAgents: (): Promise<DetectedAgent[]> => req("/agents/detect").then(j),
  // 这个 CLI 现在有哪些模型:server 会去问 CLI 自己(`grok models` 之类)并缓存,
  // 问不到就返回内置快照。手机端只读不刷新 —— 强制刷新是桌面端选择器上的动作,
  // 这里跟着 server 的缓存走就够(它本来就会过期重探)。
  cliModels: (type: AgentType): Promise<CliModelCatalog[]> =>
    req(`/agents/models?type=${encodeURIComponent(type)}`).then(j),

  // 某个执行器在某个项目下已装的 `/技能`。手机只拿来做补全:选中一条就是把
  // `/名字` 写进输入框，原文保留；server 运行前会注入对应 SKILL.md。
  skills: (query: {
    agentType: string;
    projectId?: string;
    executorId?: string;
  }): Promise<SkillList> => {
    const params = new URLSearchParams({ agentType: query.agentType });
    if (query.projectId) params.set("projectId", query.projectId);
    if (query.executorId) params.set("executorId", query.executorId);
    return req(`/skills?${params.toString()}`).then(j);
  },

  llmProviders: (): Promise<LlmProvider[]> => req("/llm-providers").then(j),
  probeModels: (body: {
    protocol: LlmProtocol;
    baseUrl: string;
    id?: string;
  }): Promise<{ models: string[] }> =>
    req("/llm-providers/models", { method: "POST", body: JSON.stringify(body) }).then(j),
};
