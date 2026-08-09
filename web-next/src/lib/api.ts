import type {
  AgentExecutorProfile,
  AgentType,
  AppSettings,
  AttachmentKind,
  BatchCreateTasksBody,
  FreeReviewDispatchInput,
  FreeWorkflowState,
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
  ReviewerProfile,
  Schedule,
  ScheduledMessage,
  SearchHit,
  Session,
  SkillList,
  SkillScanOverview,
  Task,
  TaskFollowUp,
  TaskReviewInfo,
  TaskWorkspaceDiscardResult,
  TaskWorkspaceLeftover,
  TeamPreset,
  TeamPresetConfig,
  TokenUsage,
} from "@harness/shared";
import { DEFAULT_APP_SETTINGS } from "@harness/shared";
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
    | { kind: "attachment"; path: string }
    | { kind: "error"; message: string }
    // 这一回合的 token 账（服务端每轮至多写一条）。它不是执行过程里的一步，渲染时
    // 要单独摘出去，别混进「执行过程」那串事件。
    | { kind: "usage"; usage: TokenUsage; accounting?: "incremental" };
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

/** 任务实际在哪干活。服务端只读地解析，绝不为了看文件而新建 worktree。 */
export type FileWorkspaceRoot = {
  path: string;
  branch: string | null;
  gitRepo: boolean;
  source: "session" | "worktree" | "repo";
};

export type FileEntry = {
  name: string;
  path: string;
  kind: "dir" | "file";
  size: number;
  mtime: string | null;
  ignored: boolean;
  symlink: boolean;
};

export type FileListing = {
  root: FileWorkspaceRoot;
  path: string;
  entries: FileEntry[];
  truncated: boolean;
};

export type FileContent = {
  path: string;
  name: string;
  size: number;
  mtime: string | null;
  kind: "text" | "image" | "pdf" | "binary";
  text: string | null;
  truncated: boolean;
  absPath: string;
  mime: string | null;
};

/** 本机上能打开某个文件的一个应用。`match` 说明它凭什么被列进来。 */
export type AppOpener = {
  id: string;
  name: string;
  detail: string;
  match: "extension" | "type" | "generic";
  isDefault: boolean;
};

export type OpenerProbe = {
  platform: string;
  canReveal: boolean;
  apps: AppOpener[];
  note: string | null;
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

// 人工强制通过一站「自动验证」之后的落点：签字之后线可能停在下一道关口、又开了一轮
// 验证、也可能直接合并完了，所以回的是**推进之后**的游标与验收阶段。
export type VerifyOverrideResult = {
  forced: true;
  taskId: string;
  station: string;
  workflowAt: string | null;
  stage: string | null;
  /** 签字落下了，但这一站之后那一段没跑完 —— 如实说，别报成一句「已放行」。 */
  advanceError?: string;
};

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

export type TerminalSessionInfo = {
  id: string;
  projectId: string;
  cwd: string;
  shell: string;
  name: string;
};

export type TerminalEvent =
  | { seq: number; type: "data"; data: string }
  | { seq: number; type: "exit"; exitCode: number; signal?: number };

export type ReplyTaskResult =
  | { started: true }
  | { scheduled: true; message: ScheduledMessage };

export const api = {
  // 老服务端不认识新加的设置项时会漏字段,补上出厂默认再交出去 —— 界面上出现
  // 「每 undefined 秒」这种东西比少一个设置项更难看,而且它没法自愈。
  settings: async (): Promise<AppSettings> => ({
    ...DEFAULT_APP_SETTINGS,
    ...(await request<AppSettings>("/settings")),
  }),
  patchSettings: async (patch: Partial<AppSettings>): Promise<AppSettings> => ({
    ...DEFAULT_APP_SETTINGS,
    ...(await request<AppSettings>("/settings", json("PATCH", patch))),
  }),

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
  createTerminalSession: (
    projectId: string,
    size: { cols: number; rows: number },
  ): Promise<TerminalSessionInfo> =>
    request(`/projects/${id(projectId)}/terminal/sessions`, json("POST", size)),
  terminalEventsUrl: (projectId: string, sessionId: string): string =>
    apiPath(`/projects/${id(projectId)}/terminal/sessions/${id(sessionId)}/events`),
  writeTerminalSession: (projectId: string, sessionId: string, data: string): Promise<void> =>
    request(`/projects/${id(projectId)}/terminal/sessions/${id(sessionId)}/input`, json("POST", { data })),
  resizeTerminalSession: (
    projectId: string,
    sessionId: string,
    size: { cols: number; rows: number },
  ): Promise<void> =>
    request(`/projects/${id(projectId)}/terminal/sessions/${id(sessionId)}/resize`, json("POST", size)),
  closeTerminalSession: (projectId: string, sessionId: string): Promise<void> =>
    request(`/projects/${id(projectId)}/terminal/sessions/${id(sessionId)}`, { method: "DELETE" }),
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
  iterateTeamDuet: (taskId: string): Promise<Task> =>
    request(`/tasks/${id(taskId)}/team/iterate-duet`, { method: "POST" }),

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
  freeWorkflow: (taskId: string): Promise<FreeWorkflowState> =>
    request(`/tasks/${id(taskId)}/free-workflow`),
  dispatchFreeReview: (taskId: string, input: FreeReviewDispatchInput): Promise<FreeWorkflowState> =>
    request(`/tasks/${id(taskId)}/free-workflow/review`, json("POST", input)),
  reserveFreeReview: (taskId: string, input: FreeReviewDispatchInput): Promise<FreeWorkflowState> =>
    request(`/tasks/${id(taskId)}/free-workflow/review-reservation`, json("PUT", input)),
  cancelFreeReviewReservation: (taskId: string): Promise<FreeWorkflowState> =>
    request(`/tasks/${id(taskId)}/free-workflow/review-reservation`, { method: "DELETE" }),
  startFreePreview: (taskId: string): Promise<FreeWorkflowState["preview"]> =>
    request(`/tasks/${id(taskId)}/free-workflow/preview`, { method: "POST" }),
  stopFreePreview: (taskId: string): Promise<{ stopped: boolean }> =>
    request(`/tasks/${id(taskId)}/free-workflow/preview`, { method: "DELETE" }),
  mergeFreeWorkflow: (taskId: string): Promise<{ merged: true; message: string }> =>
    request(`/tasks/${id(taskId)}/free-workflow/merge`, { method: "POST" }),
  freeReviewFileUrl: (taskId: string, runId: string, round: number, name: string): string =>
    apiPath(`/tasks/${id(taskId)}/free-workflow/review-file?run=${id(runId)}&round=${id(String(round))}&name=${id(name)}`),
  // 人工替这一站「自动验证」签字放行。**后端会接着把这一站之后那一段跑掉**——线上
  // 画着「合并并清理」时这一按就是真合并，调用点必须先把话说清楚再让人按。
  forcePassVerify: (taskId: string): Promise<VerifyOverrideResult> =>
    request(`/tasks/${id(taskId)}/workflow/verify-override`, { method: "POST" }),
  // 把「打开预览」这一站按原样再跑一次。**这条路不推线**（游标、验证轮数一律不动），
  // 而且要等预览真起来才返回——最长两分钟，调用点得让按钮一直转着。
  restartPreview: (
    taskId: string,
    stepId: string,
  ): Promise<{ ok: true; url: string | null; port: number | null }> =>
    request(`/tasks/${id(taskId)}/preview/restart`, json("POST", { stepId })),
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

  taskFiles: (taskId: string, path = ""): Promise<FileListing> =>
    request(`/tasks/${id(taskId)}/files?path=${id(path)}`),
  taskFile: (taskId: string, path: string): Promise<{ root: FileWorkspaceRoot; file: FileContent }> =>
    request(`/tasks/${id(taskId)}/file?path=${id(path)}`),
  // 图片/PDF 预览直接把这个地址交给 <img>/<iframe>，不经过 JSON。
  taskFileRawUrl: (taskId: string, path: string): string =>
    apiPath(`/tasks/${id(taskId)}/file/raw?path=${id(path)}`),
  taskFileOpeners: (taskId: string, path: string, refresh = false): Promise<OpenerProbe> =>
    request(`/tasks/${id(taskId)}/file/openers?path=${id(path)}${refresh ? "&refresh=1" : ""}`),
  revealTaskFile: (taskId: string, path: string): Promise<{ ok: true; absPath: string }> =>
    request(`/tasks/${id(taskId)}/file/reveal`, json("POST", { path })),
  openTaskFile: (
    taskId: string,
    path: string,
    appId: string | null,
  ): Promise<{ ok: true; absPath: string }> =>
    request(`/tasks/${id(taskId)}/file/open`, json("POST", { path, appId })),

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
  // 这个执行器在这个项目下已经装了哪些 `/技能`。refresh=true 跳过服务端的指纹缓存。
  skills: (query: {
    agentType: string;
    projectId?: string;
    executorId?: string;
    refresh?: boolean;
  }): Promise<SkillList> => {
    const params = new URLSearchParams({ agentType: query.agentType });
    if (query.projectId) params.set("projectId", query.projectId);
    if (query.executorId) params.set("executorId", query.executorId);
    if (query.refresh) params.set("refresh", "1");
    return request(`/skills?${params.toString()}`);
  },
  // 设置页:每个已注册执行器各自扫到多少技能。rescan 版强制重扫(绕过指纹缓存)。
  skillsOverview: (projectId?: string): Promise<SkillScanOverview> =>
    request(`/skills/overview${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  rescanSkills: (projectId?: string): Promise<SkillScanOverview> =>
    request(`/skills/rescan${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`, json("POST", {})),
  createAgent: (agent: Partial<AgentExecutorProfile>): Promise<AgentExecutorProfile> =>
    request("/agents", json("POST", agent)),
  patchAgent: (
    agentId: string,
    patch: Partial<AgentExecutorProfile>,
  ): Promise<AgentExecutorProfile> => request(`/agents/${id(agentId)}`, json("PATCH", patch)),
  deleteAgent: (agentId: string): Promise<{ deleted: true }> =>
    request(`/agents/${id(agentId)}`, { method: "DELETE" }),

  reviewerProfiles: (): Promise<ReviewerProfile[]> => request("/reviewer-profiles"),
  createReviewerProfile: (
    profile: Pick<ReviewerProfile, "name" | "agentType" | "executorId" | "model" | "reasoningEffort">,
  ): Promise<ReviewerProfile> => request("/reviewer-profiles", json("POST", profile)),
  patchReviewerProfile: (
    profileId: string,
    patch: Partial<Pick<ReviewerProfile, "name" | "agentType" | "executorId" | "model" | "reasoningEffort">>,
  ): Promise<ReviewerProfile> => request(`/reviewer-profiles/${id(profileId)}`, json("PATCH", patch)),
  deleteReviewerProfile: (profileId: string): Promise<{ deleted: true }> =>
    request(`/reviewer-profiles/${id(profileId)}`, { method: "DELETE" }),

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
  duetTranscript: (taskId: string): Promise<unknown[]> =>
    request(`/tasks/${id(taskId)}/duet`),

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
