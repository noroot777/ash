import type {
  AgentExecutorProfile,
  AgentType,
  AppSettings,
  AttachmentKind,
  BatchCreateTasksBody,
  GateAction,
  Group,
  LlmProtocol,
  LlmProvider,
  Note,
  Project,
  ProjectHealth,
  ProjectView,
  ProviderModelListMode,
  ReviewDispatchInput,
  Schedule,
  ScheduledMessage,
  SearchHit,
  Session,
  Task,
  TaskFollowUp,
  TaskReviewInfo,
  TaskWorkspaceDiscardResult,
  TaskWorkspaceLeftover,
  TeamPreset,
  TeamPresetConfig,
} from "@harness/shared";
import type { WorkflowDef, WorkflowItem } from "@harness/shared/workflow";

const API_ROOT = "/api";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function apiPath(path: string): string {
  return `${API_ROOT}${path.startsWith("/") ? path : `/${path}`}`;
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiPath(path), init);
  const body = await parseBody(response);
  if (!response.ok) {
    throw apiError(response, body);
  }
  return body as T;
}

function apiError(response: Response, body: unknown): ApiError {
  const message =
    typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : `${response.status} 请求失败`;
  return new ApiError(response.status, message, body);
}

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

const id = encodeURIComponent;

export type DeleteTaskResult = {
  deleted: true;
  leftover: TaskWorkspaceLeftover | null;
  cleanup: TaskWorkspaceDiscardResult | null;
};

export type TaskCommit = { sha: string; subject: string; at: string };

export type SessionTraceEntry = {
  at: string;
  turnStartedAt: string;
  event:
    | { kind: "text"; text: string }
    | { kind: "thinking"; text: string }
    | { kind: "tool"; name: string; detail?: string }
    | { kind: "error"; message: string };
};

export type GitOverview = {
  branches: string[];
  current: string | null;
  worktrees: {
    path: string;
    branch: string | null;
    head: string | null;
    detached: boolean;
  }[];
};

export type TaskDiffResult = {
  available: boolean;
  sourceBranch: string;
  targetBranch: string | null;
  mergeBase: string | null;
  diff: string;
  files: { path: string; additions: number | null; deletions: number | null }[];
  truncated: boolean;
  limitBytes: number;
  reason?: string;
};

export type AcceptTaskWarning = {
  reason: "temporary_cleanup_failed";
  message: string;
  worktreePath: string;
};

export type AcceptTaskSuccess = {
  accepted: true;
  taskId: string;
  status: string;
  /** 中途关口放行不是验收，stage 会被清回「进行中」 */
  stage: "accepted" | null;
  kind: "already_accepted" | "in_place" | "isolated_worktree" | "marked_only" | "gate_released";
  sharedWorkersAccepted?: number;
  targetBranch?: string;
  merge?: string;
  worktreePath?: string;
  worktreeRemoved?: boolean;
  branch?: string;
  branchDeleted?: boolean;
  warnings?: AcceptTaskWarning[];
  /** 「点头之后」那一段（发布脚本之类）跑得怎么样；线上没写这一段就没有这个字段 */
  tail?: { ok: boolean; step?: string; reason?: string };
};

export type AcceptTaskFailure = {
  accepted: false;
  taskId: string;
  reason: string;
  error: string;
  status?: string;
  sourceBranch?: string;
  targetBranch?: string | null;
  conflictFiles?: string[];
  dirtyFiles?: string[];
  targetPath?: string;
  worktreePath?: string;
  phase?: "initial" | "before_accept" | "before_merge" | "before_cleanup";
  inFlightTasks?: {
    id: string;
    title: string;
    status: string;
    role: "task" | "shared_worker";
  }[];
  warnings?: AcceptTaskWarning[];
  conflictHandoff?: { notified: boolean; message: string };
};

export type AcceptTaskResult = AcceptTaskSuccess | AcceptTaskFailure;

function isAcceptTaskResult(body: unknown): body is AcceptTaskResult {
  return typeof body === "object" && body !== null && "accepted" in body &&
    typeof body.accepted === "boolean";
}

export type DetectedCli = {
  key: string;
  name: string;
  description: string;
  bins: string[];
  docsUrl: string;
  installCommand: string;
  type?: AgentType;
  bin: string;
  available: boolean;
  path: string | null;
  version: string | null;
  resident: boolean;
};

export type CuaProcess = { pid: number; ppid: number; command: string };

export type TeamCuaStatus = {
  taskId: string;
  current: {
    checkedAt: string;
    detected: boolean;
    processes: CuaProcess[];
    message: string;
    sideEffect: string;
  };
};

export type ReplyTaskResult =
  | { started: true }
  | { scheduled: true; message: ScheduledMessage };

export const api = {
  settings: (): Promise<AppSettings> => request("/settings"),
  patchSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    request("/settings", json("PATCH", patch)),

  projects: (): Promise<ProjectView[]> => request("/projects"),
  createProject: (name: string, repoPath: string): Promise<ProjectView> =>
    request("/projects", json("POST", { name, repoPath })),
  resolveProject: (repoPath: string, name?: string): Promise<ProjectView> =>
    request("/projects/resolve", json("POST", { repoPath, name })),
  updateProject: (
    projectId: string,
    patch: Partial<Pick<Project, "name" | "repoPath" | "workflowId">>,
  ): Promise<ProjectView> => request(`/projects/${id(projectId)}`, json("PATCH", patch)),
  deleteProject: (projectId: string): Promise<{ deleted: true }> =>
    request(`/projects/${id(projectId)}`, { method: "DELETE" }),
  projectHealth: (projectId: string): Promise<ProjectHealth> =>
    request(`/projects/${id(projectId)}/health`),
  projectBranches: (projectId: string): Promise<{ branches: string[]; current: string | null }> =>
    request(`/projects/${id(projectId)}/branches`),
  projectGitOverview: (projectId: string): Promise<GitOverview> =>
    request(`/projects/${id(projectId)}/git-overview`),
  checkPath: (repoPath: string): Promise<ProjectHealth> =>
    request("/projects/check", json("POST", { repoPath })),
  discardTaskWorkspace: (
    projectId: string,
    body: { taskId: string; worktree?: boolean; branch?: boolean; force?: boolean },
  ): Promise<TaskWorkspaceDiscardResult> =>
    request(`/projects/${id(projectId)}/workspaces/discard`, json("POST", body)),

  groups: (projectId?: string): Promise<Group[]> =>
    request(`/groups${projectId ? `?projectId=${id(projectId)}` : ""}`),
  groupsByOwnerTask: (taskId: string): Promise<Group[]> =>
    request(`/groups?ownerTaskId=${id(taskId)}`),
  createGroup: (
    group: Partial<Group> & { name: string; projectId?: string; repoPath?: string },
  ): Promise<Group> => request("/groups", json("POST", group)),
  updateGroup: (groupId: string, patch: Partial<Pick<Group, "name" | "mode">>): Promise<Group> =>
    request(`/groups/${id(groupId)}`, json("PATCH", patch)),
  deleteGroup: (groupId: string): Promise<{ deleted: true }> =>
    request(`/groups/${id(groupId)}`, { method: "DELETE" }),
  runGroup: (groupId: string): Promise<unknown> =>
    request(`/groups/${id(groupId)}/run`, { method: "POST" }),
  pauseGroup: (groupId: string): Promise<Group> =>
    request(`/groups/${id(groupId)}/pause`, { method: "POST" }),
  createTasksBatch: (
    groupId: string,
    body: BatchCreateTasksBody,
  ): Promise<{ groupId: string; run: boolean; tasks: Task[] }> =>
    request(`/groups/${id(groupId)}/tasks/batch`, json("POST", body)),

  tasks: (): Promise<Task[]> => request("/tasks"),
  task: (taskId: string): Promise<Task> => request(`/tasks/${id(taskId)}`),
  // 侧边栏铺开那一下才调：一批任务各自「我发的最后一条追问」。没有的任务不在返回里。
  followUps: (taskIds: string[]): Promise<TaskFollowUp[]> =>
    request("/tasks/follow-ups", json("POST", { taskIds })),
  createTask: (
    task: Partial<Task> & {
      projectId: string;
      title: string;
      attachments?: string[];
      // 挑哪条起手式；task.workflow 非空时它已经是就地改过的快照，服务端直接落库
      workflowId?: string | null;
    },
  ): Promise<Task> => request("/tasks", json("POST", task)),
  patchTask: (taskId: string, patch: Partial<Task>): Promise<Task> =>
    request(`/tasks/${id(taskId)}`, json("PATCH", patch)),
  deleteTask: (
    taskId: string,
    cleanup?: { worktree?: boolean; branch?: boolean; force?: boolean },
  ): Promise<DeleteTaskResult> => {
    const params = new URLSearchParams();
    if (cleanup?.worktree) params.set("worktree", "1");
    if (cleanup?.branch) params.set("branch", "1");
    if (cleanup?.force) params.set("force", "1");
    const query = params.toString();
    return request(`/tasks/${id(taskId)}${query ? `?${query}` : ""}`, { method: "DELETE" });
  },
  runTask: (taskId: string): Promise<unknown> =>
    request(`/tasks/${id(taskId)}/run`, { method: "POST" }),
  stopTask: (taskId: string): Promise<unknown> =>
    request(`/tasks/${id(taskId)}/stop`, { method: "POST" }),
  retryTask: (taskId: string): Promise<unknown> =>
    request(`/tasks/${id(taskId)}/retry`, { method: "POST" }),
  requeueTask: (taskId: string): Promise<{ task: Task; movedToEnd: boolean }> =>
    request(`/tasks/${id(taskId)}/requeue`, { method: "POST" }),
  fireTask: (taskId: string): Promise<unknown> =>
    request(`/tasks/${id(taskId)}/fire`, { method: "POST" }),
  archiveTask: (taskId: string): Promise<Task> =>
    request(`/tasks/${id(taskId)}/archive`, { method: "POST" }),
  unarchiveTask: (taskId: string): Promise<Task> =>
    request(`/tasks/${id(taskId)}/unarchive`, { method: "POST" }),
  answerTask: (taskId: string, answer: string): Promise<unknown> =>
    request(`/tasks/${id(taskId)}/answer`, json("POST", { answer })),
  replyTask: (
    taskId: string,
    text: string,
    // executorId/model 只作用于这一回合：@ 出来的那一步是显式选择，别写回任务常设配置。
    options?: {
      attachments?: string[];
      agent?: AgentType;
      executorId?: string | null;
      model?: string | null;
      reasoningEffort?: string | null;
      sendAt?: string;
    },
  ): Promise<ReplyTaskResult> =>
    request(`/tasks/${id(taskId)}/reply`, json("POST", { text, ...options })),
  gate: (taskId: string, action: GateAction): Promise<unknown> =>
    request(`/tasks/${id(taskId)}/gate`, json("POST", action)),
  teamHalt: (taskId: string): Promise<{ ok: true }> =>
    request(`/tasks/${id(taskId)}/team/halt`, { method: "POST" }),
  teamCuaStatus: (taskId: string): Promise<TeamCuaStatus> =>
    request(`/tasks/${id(taskId)}/team/cua-status`),
  killTeamCua: (taskId: string): Promise<unknown> =>
    request(`/tasks/${id(taskId)}/team/kill-cua`, { method: "POST" }),
  iterateTeamDebate: (taskId: string): Promise<Task> =>
    request(`/tasks/${id(taskId)}/team/iterate-debate`, { method: "POST" }),

  taskWorkspace: (taskId: string): Promise<TaskWorkspaceLeftover> =>
    request(`/tasks/${id(taskId)}/workspace`),
  taskReview: (taskId: string): Promise<TaskReviewInfo> =>
    request(`/tasks/${id(taskId)}/review`),
  // 验证轮就跑在原任务身上（不再另起审查任务），所以只回一个轮次号。
  dispatchTaskReview: (
    taskId: string,
    input: ReviewDispatchInput,
  ): Promise<{ round: number }> =>
    request(`/tasks/${id(taskId)}/review/dispatch`, json("POST", input)),
  taskReviewFileUrl: (taskId: string, round: number, name: string): string =>
    apiPath(`/tasks/${id(taskId)}/review/file?round=${id(String(round))}&name=${id(name)}`),
  acceptTask: async (taskId: string): Promise<AcceptTaskResult> => {
    const response = await fetch(apiPath(`/tasks/${id(taskId)}/accept`), { method: "POST" });
    const body = await parseBody(response);
    if (isAcceptTaskResult(body)) return body;
    throw apiError(response, body);
  },
  taskDiff: (taskId: string): Promise<TaskDiffResult> =>
    request(`/tasks/${id(taskId)}/diff`),
  taskCommits: (taskId: string): Promise<{ branch: string | null; commits: TaskCommit[] }> =>
    request(`/tasks/${id(taskId)}/commits`),

  notes: (projectId?: string): Promise<Note[]> =>
    request(`/notes${projectId ? `?projectId=${id(projectId)}` : ""}`),
  createNote: (note: { projectId: string; body: string; attachments?: string[] }): Promise<Note> =>
    request("/notes", json("POST", note)),
  patchNote: (
    noteId: string,
    patch: Partial<Pick<Note, "body" | "attachments">> & { taskId?: string | null },
  ): Promise<Note> => request(`/notes/${id(noteId)}`, json("PATCH", patch)),
  deleteNote: (noteId: string): Promise<{ deleted: true }> =>
    request(`/notes/${id(noteId)}`, { method: "DELETE" }),

  search: (
    query: string,
    scope?: { projectId?: string; type?: "tasks" | "notes" },
  ): Promise<SearchHit[]> => {
    const params = new URLSearchParams({ q: query });
    if (scope?.projectId) params.set("projectId", scope.projectId);
    if (scope?.type) params.set("type", scope.type);
    return request(`/search?${params}`);
  },
  uploadFile: (
    dataUrl: string,
    name: string,
  ): Promise<{ id: string; path: string; url: string; name: string; kind: AttachmentKind }> =>
    request("/uploads", json("POST", { dataUrl, name })),

  agents: (): Promise<AgentExecutorProfile[]> => request("/agents"),
  detectAgents: (): Promise<
    { type: AgentType; bin: string; available: boolean; path: string | null; version: string | null; resident: boolean }[]
  > => request("/agents/detect"),
  detectClis: (): Promise<DetectedCli[]> => request("/agents/catalog"),
  createAgent: (agent: Partial<AgentExecutorProfile>): Promise<AgentExecutorProfile> =>
    request("/agents", json("POST", agent)),
  patchAgent: (
    agentId: string,
    patch: Partial<AgentExecutorProfile>,
  ): Promise<AgentExecutorProfile> => request(`/agents/${id(agentId)}`, json("PATCH", patch)),
  deleteAgent: (agentId: string): Promise<{ deleted: true }> =>
    request(`/agents/${id(agentId)}`, { method: "DELETE" }),

  // 起手式库。自带条目的 id 就是内置 key（"standard"），删不掉——DELETE 会 409，
  // 「不想看见它」走 patchWorkflow({disabled:true})，「改坏了」走 restoreWorkflow。
  workflows: (): Promise<WorkflowItem[]> => request("/workflows"),
  createWorkflow: (body: {
    name: string;
    description?: string;
    def: WorkflowDef;
  }): Promise<WorkflowItem> => request("/workflows", json("POST", body)),
  patchWorkflow: (
    workflowId: string,
    patch: { name?: string; description?: string; def?: WorkflowDef; disabled?: boolean },
  ): Promise<WorkflowItem> => request(`/workflows/${id(workflowId)}`, json("PATCH", patch)),
  deleteWorkflow: (workflowId: string): Promise<{ deleted: true }> =>
    request(`/workflows/${id(workflowId)}`, { method: "DELETE" }),
  restoreWorkflow: (workflowId: string): Promise<WorkflowItem> =>
    request(`/workflows/${id(workflowId)}/restore`, { method: "POST" }),

  teamPresets: (): Promise<TeamPreset[]> => request("/team-presets"),  createTeamPreset: (name: string, config: TeamPresetConfig): Promise<TeamPreset> =>
    request("/team-presets", json("POST", { name, config })),
  patchTeamPreset: (
    presetId: string,
    patch: { name?: string; config?: TeamPresetConfig },
  ): Promise<TeamPreset> => request(`/team-presets/${id(presetId)}`, json("PATCH", patch)),
  deleteTeamPreset: (presetId: string): Promise<{ deleted: true }> =>
    request(`/team-presets/${id(presetId)}`, { method: "DELETE" }),

  sessions: (taskId: string): Promise<Session[]> => request(`/tasks/${id(taskId)}/sessions`),
  sessionOutput: async (sessionId: string): Promise<string> => {
    const response = await fetch(apiPath(`/sessions/${id(sessionId)}/output`));
    if (!response.ok) throw new ApiError(response.status, `${response.status} 会话输出读取失败`, null);
    return response.text();
  },
  sessionTrace: (sessionId: string): Promise<SessionTraceEntry[]> =>
    request(`/sessions/${id(sessionId)}/trace`),
  debateTranscript: (taskId: string): Promise<unknown[]> =>
    request(`/tasks/${id(taskId)}/debate`),

  schedule: (taskId: string): Promise<Schedule | null> =>
    request(`/tasks/${id(taskId)}/schedule`),
  setSchedule: (
    taskId: string,
    schedule: { kind: "once" | "cron"; at?: string | null; cron?: string | null },
  ): Promise<Schedule> => request(`/tasks/${id(taskId)}/schedule`, json("PUT", schedule)),
  clearSchedule: (taskId: string): Promise<unknown> =>
    request(`/tasks/${id(taskId)}/schedule`, { method: "DELETE" }),
  scheduledMessages: (taskId: string): Promise<ScheduledMessage[]> =>
    request(`/tasks/${id(taskId)}/scheduled-messages`),
  cancelScheduledMessage: (messageId: string): Promise<unknown> =>
    request(`/scheduled-messages/${id(messageId)}`, { method: "DELETE" }),

  llmProviders: (): Promise<LlmProvider[]> => request("/llm-providers"),
  probeModels: (body: {
    protocol: LlmProtocol;
    baseUrl: string;
    apiKey?: string;
    id?: string;
  }): Promise<{ models: string[] }> => request("/llm-providers/models", json("POST", body)),
  testLlmProvider: (body: {
    id?: string;
    protocol?: LlmProtocol;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    protocolConversionEnabled?: boolean;
  }): Promise<{ ok: true; model: string; reply: string; elapsedMs: number; endpoint: string }> =>
    request("/llm-providers/test", json("POST", body)),
  createLlmProvider: (provider: {
    name: string;
    protocol: LlmProtocol;
    baseUrl: string;
    apiKey: string;
    model: string;
    protocolConversionEnabled: boolean;
    modelListMode?: ProviderModelListMode;
    pinnedModels?: string[];
  }): Promise<LlmProvider> => request("/llm-providers", json("POST", provider)),
  patchLlmProvider: (
    providerId: string,
    patch: Partial<{
      name: string;
      protocol: LlmProtocol;
      baseUrl: string;
      apiKey: string;
      model: string;
      protocolConversionEnabled: boolean;
      modelListMode: ProviderModelListMode;
      pinnedModels: string[];
    }>,
  ): Promise<LlmProvider> => request(`/llm-providers/${id(providerId)}`, json("PATCH", patch)),
  deleteLlmProvider: (providerId: string): Promise<{ deleted: true }> =>
    request(`/llm-providers/${id(providerId)}`, { method: "DELETE" }),

  queue: (queueId: string): Promise<{
    queueId: string;
    groupId: string | null;
    items: { taskId: string; position: number; title: string; status: string | null; archived: boolean }[];
  }> => request(`/queues/${id(queueId)}`),
  queueReorder: (queueId: string, taskIds: string[]): Promise<{ ok: true }> =>
    request(`/queues/${id(queueId)}/reorder`, json("POST", { taskIds })),
  queueRemove: (queueId: string, taskId: string): Promise<{ ok: true }> =>
    request(`/queues/${id(queueId)}/remove`, json("POST", { taskId })),
};
