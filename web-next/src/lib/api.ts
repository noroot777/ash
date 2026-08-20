import type {
  AgentExecutorProfile,
  AgentType,
  AppSettings,
  AttachmentKind,
  BatchCreateTasksBody,
  FreeReviewDispatchInput,
  GateAction,
  Group,
  HandoffExportResult,
  HandoffPreflightResult,
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
  TeamPreset,
  TeamPresetConfig,
} from "@harness/shared";
import { DEFAULT_APP_SETTINGS } from "@harness/shared";
import type { WorkflowDef, WorkflowItem } from "@harness/shared/workflow";
import type { CliHostEnv } from "@harness/shared/cli-overrides";
import type { CliModelCatalog } from "@harness/shared/cli-presets";
import { ApiError, apiError, apiPath, id, json, parseBody, request } from "./apiClient.ts";
import type {
  AcceptTaskResult,
  DeleteTaskResult,
  DetectedCli,
  DirectoryPick,
  FileContent,
  FileListing,
  FileWorkspaceRoot,
  FreeWorkflowApiState,
  GitOverview,
  HostInfo,
  OpenerProbe,
  ReplyTaskResult,
  ScmCommitResult,
  ScmDiffSource,
  ScmFileDiff,
  ScmOverview,
  ScmWriteResult,
  SessionTraceEntry,
  TaskCommit,
  TaskDiffResult,
  TaskWorkspaceProbe,
  TeamCuaStatus,
  TerminalSessionInfo,
  VerifyOverrideResult,
} from "./apiTypes.ts";

// 调用点只认 `lib/api`：传输层（apiClient.ts）和返回体形状（apiTypes.ts）是这份端点
// 清单为了守住 700 行上限拆出去的实现细节，不该逼着几十个 import 跟着改路径。
export { ApiError } from "./apiClient.ts";
export type * from "./apiTypes.ts";

function isAcceptTaskResult(body: unknown): body is AcceptTaskResult {
  return typeof body === "object" && body !== null && "accepted" in body &&
    typeof body.accepted === "boolean";
}

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
  // 只读的运行时事实（平台/分隔符/家目录），跟可写的 `/settings` 是两回事。
  // 调用点走 `useHostInfo.ts`：整个前端只该拉一次。
  host: (): Promise<HostInfo> => request("/host"),
  // 在**服务端那台机器**上弹一个系统文件选择窗口。请求会一直挂到用户点完或取消，
  // 所以调用点必须给出「正在选择」的反馈；`canPickDirectory` 为假时别调。
  pickDirectory: (startIn: string): Promise<DirectoryPick> =>
    request("/host/pick-directory", json("POST", { startIn })),

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
  // 重跑**上一回合**（续聊/审查打回的那一句崩了，但任务还停在 done）。带上气泡上那条
  // 会话 id：服务端据此确认「用户看到的就是最新一次」，页面旧了就拒绝而不是照跑。
  // mode=review = 上一回合是自由工作流的审查回合，重跑的是**那一轮审查**（同一位审查者）。
  retryTurn: (taskId: string, sessionId?: string): Promise<{ started: true; mode: "resend" | "resume" | "review" }> =>
    request(`/tasks/${id(taskId)}/retry-turn`, json("POST", { sessionId })),
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

  // 任务接力:preflight 只读探测对端与本地可搬运的东西;handoffTask 会真的停下任务、
  // 打包 git 分支与 CLI 会话文件推给对端(可能上百 MB,调用点要给持续的忙碌反馈)。
  handoffPreflight: (taskId: string, targetUrl: string): Promise<HandoffPreflightResult> =>
    request(`/tasks/${id(taskId)}/handoff/preflight`, json("POST", { targetUrl })),
  handoffTask: (
    taskId: string,
    body: { targetUrl: string; targetProjectId: string; targetName?: string; autoResume?: boolean },
  ): Promise<HandoffExportResult> =>
    request(`/tasks/${id(taskId)}/handoff`, json("POST", body)),
  // 移除接力标记(「在本机继续」的逃生门):只清本机标记,对端那份任务不动。
  clearHandoff: (taskId: string): Promise<{ cleared: true }> =>
    request(`/tasks/${id(taskId)}/handoff`, { method: "DELETE" }),

  taskWorkspace: (taskId: string): Promise<TaskWorkspaceProbe> =>
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
  freeWorkflow: (taskId: string): Promise<FreeWorkflowApiState> =>
    request(`/tasks/${id(taskId)}/free-workflow`),
  dispatchFreeReview: (taskId: string, input: FreeReviewDispatchInput): Promise<FreeWorkflowApiState> =>
    request(`/tasks/${id(taskId)}/free-workflow/review`, json("POST", input)),
  dispatchPostMergeReview: (taskId: string, input: FreeReviewDispatchInput): Promise<FreeWorkflowApiState> =>
    request(`/tasks/${id(taskId)}/free-workflow/post-merge-review`, json("POST", input)),
  createPostMergeRepairTask: (taskId: string, runId: string): Promise<Task> =>
    request(`/tasks/${id(taskId)}/free-workflow/post-merge-review/repair`, json("POST", { runId })),
  repairFreeReview: (taskId: string): Promise<FreeWorkflowApiState> =>
    request(`/tasks/${id(taskId)}/free-workflow/review/repair`, { method: "POST" }),
  reserveFreeReview: (taskId: string, input: FreeReviewDispatchInput): Promise<FreeWorkflowApiState> =>
    request(`/tasks/${id(taskId)}/free-workflow/review-reservation`, json("PUT", input)),
  cancelFreeReviewReservation: (taskId: string): Promise<FreeWorkflowApiState> =>
    request(`/tasks/${id(taskId)}/free-workflow/review-reservation`, { method: "DELETE" }),
  startFreePreview: (taskId: string): Promise<FreeWorkflowApiState["preview"]> =>
    request(`/tasks/${id(taskId)}/free-workflow/preview`, { method: "POST" }),
  stopFreePreview: (taskId: string): Promise<{ stopped: boolean }> =>
    request(`/tasks/${id(taskId)}/free-workflow/preview`, { method: "DELETE" }),
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
    request(`/tasks/${id(taskId)}/file/openers?path=${id(path)}${refresh ? "&refresh=1" : ""}`),  revealTaskFile: (taskId: string, path: string): Promise<{ ok: true; absPath: string }> =>
    request(`/tasks/${id(taskId)}/file/reveal`, json("POST", { path })),
  openTaskFile: (
    taskId: string,
    path: string,
    appId: string | null,
  ): Promise<{ ok: true; absPath: string }> =>
    request(`/tasks/${id(taskId)}/file/open`, json("POST", { path, appId })),

  // 工作区源代码管理。写操作在任务运行中会被后端拦成 409（body 带 needsForce），
  // 由调用点弹确认框后带 force 重试——别在这一层偷偷补 force。
  taskScm: (taskId: string): Promise<ScmOverview> =>
    request(`/tasks/${id(taskId)}/scm`),
  taskScmDiff: (
    taskId: string,
    path: string,
    source: ScmDiffSource,
    origPath?: string | null,
  ): Promise<ScmFileDiff> =>
    request(`/tasks/${id(taskId)}/scm/diff?path=${id(path)}&source=${source}${origPath ? `&origPath=${id(origPath)}` : ""}`),
  scmStage: (taskId: string, paths: string[], force = false): Promise<ScmWriteResult> =>
    request(`/tasks/${id(taskId)}/scm/stage`, json("POST", { paths, force })),
  scmUnstage: (taskId: string, paths: string[], force = false): Promise<ScmWriteResult> =>
    request(`/tasks/${id(taskId)}/scm/unstage`, json("POST", { paths, force })),
  scmDiscard: (
    taskId: string,
    paths: string[],
    deleteUntracked: string[] = [],
    force = false,
  ): Promise<ScmWriteResult> =>
    request(`/tasks/${id(taskId)}/scm/discard`, json("POST", { paths, deleteUntracked, force })),
  scmCommit: (
    taskId: string,
    message: string,
    options: { stagePaths?: string[]; amend?: boolean; force?: boolean } = {},
  ): Promise<ScmCommitResult> =>
    request(`/tasks/${id(taskId)}/scm/commit`, json("POST", { message, ...options })),

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
  // harness 起 CLI 时子进程会看到的环境事实(只读)。设置页拿它算压缩触发点 ——
  // 那个换算里有一项在 server 的环境变量里,前端自己算不出来。
  cliHostEnv: (): Promise<CliHostEnv> => request("/agents/cli-env"),
  // 这个 CLI 现在有哪些模型 —— 服务端会去问 CLI 自己(`grok models` 之类)并缓存,
  // 问不到就返回内置快照并在 `source`/`error` 里说清楚。refresh 版是用户按的「刷新」,
  // 绕过服务端缓存现问一次(所以是 POST:它真的会去起子进程,不是可重放的读)。
  cliModels: (type?: AgentType): Promise<CliModelCatalog[]> =>
    request(`/agents/models${type ? `?type=${encodeURIComponent(type)}` : ""}`),
  refreshCliModels: (type?: AgentType): Promise<CliModelCatalog[]> =>
    request(`/agents/models/refresh${type ? `?type=${encodeURIComponent(type)}` : ""}`, json("POST", {})),
  // 这个执行器在这个项目下已经装了哪些 `/技能`。refresh=true 跳过服务端的指纹缓存。
  skills: (query: {
    agentType: string;
    projectId?: string;
    refresh?: boolean;
  }): Promise<SkillList> => {
    const params = new URLSearchParams({ agentType: query.agentType });
    if (query.projectId) params.set("projectId", query.projectId);
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
