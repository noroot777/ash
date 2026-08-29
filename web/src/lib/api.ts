import type {
  AgentExecutorProfile,
  AgentType,
  AppSettings,
  AttachmentKind,
  BatchCreateTasksBody,
  ExecutorDowngradeItem,
  FreeReviewDispatchInput,
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
  TaskListItem,
  TaskReviewInfo,
  TaskWorkspaceDiscardResult,
  TeamPreset,
  TeamPresetConfig,
} from "@ash/shared";

import { DEFAULT_APP_SETTINGS } from "@ash/shared";
import type { WorkflowDef, WorkflowItem } from "@ash/shared/workflow";
import type { CliHostEnv } from "@ash/shared/cli-overrides";
import type { CliModelCatalog } from "@ash/shared/cli-presets";
import type { SearchStreamLine } from "@ash/shared/search";
import { ApiError, apiError, apiPath, id, json, parseBody, postWithProgress, request } from "./apiClient.ts";
import { handoffApi } from "./handoffApi.ts";
export type { TaskScopedHandoffPreflightResult } from "./handoffApi.ts";

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
  ProjectGitConfig,
  ProjectGitConfigPatch,
  ProjectGitResult,
  ProjectGitState,
  PullStrategy,
  ReplyTaskResult,
  ScmCommitResult,
  ScmDiffSource,
  ScmFileDiff,
  ScmOverview,
  ScmPushResult,
  ScmWriteResult,
  SessionTraceEntry,
  TaskCommit,
  TaskDiffResult,
  TaskFileDiffResult,
  TaskWorkspaceProbe,
  TeamCuaStatus,
  TerminalSessionInfo,
  VerifyOverrideResult,
} from "./apiTypes.ts";

// 调用点只认 `lib/api`：传输层（apiClient.ts）和返回体形状（apiTypes.ts）是这份端点
// 清单为了守住 700 行上限拆出去的实现细节，不该逼着几十个 import 跟着改路径。
export { ApiError } from "./apiClient.ts";
export type * from "./apiTypes.ts";
// 搜索的查询串。界面只走流式那条(`/search/stream`);服务端另有一条整份返回的
// `/search`,参数完全同形,留给脚本和 curl —— 所以这里单独拎出来,两边不会漂。
const searchQueryParams = (
  query: string,
  scope?: { projectId?: string; type?: "tasks" | "notes"; prefer?: string | null },
) => {
  const params = new URLSearchParams({ q: query });
  if (scope?.projectId) params.set("projectId", scope.projectId);
  if (scope?.type) params.set("type", scope.type);
  if (scope?.prefer) params.set("prefer", scope.prefer);
  return params;
};

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
  // `createDir` 为真时服务端会把不存在的目录（连同缺失的上级）建出来；不带它就是老行为
  // ——目录不存在也照记不误。只有在界面上明确告诉过用户「这个目录会被建出来」时才带上。
  createProject: (name: string, repoPath: string, createDir = false): Promise<ProjectView> =>
    request("/projects", json("POST", { name, repoPath, createDir })),
  // 在**服务端那台机器**上执行 git clone,成功后才登记项目。请求会一直挂到克隆结束
  // (大仓库可能几分钟),调用点必须给出持续可见的进度反馈。
  cloneProject: (
    body: {
      url: string;
      targetPath: string;
      branch?: string;
      name?: string;
      // 私有 HTTPS 仓库的用户名 + 令牌。克隆当场用，成功后存到新项目上 —— 项目行要等
      // 克隆成功才写，所以这一刻的凭证只能随请求递进来，没法先去设置页里配。
      username?: string;
      secret?: string;
    },
  ): Promise<ProjectView> => request("/projects/clone", json("POST", body)),
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

  // 项目**主仓**的 git 操作（侧栏那颗分支胶囊）。跟任务面板那套 `scm*`
  // 不是一回事：这里的目标永远是项目登记的仓库路径，改的是所有任务共用的那份 `.git`。
  projectGit: (projectId: string): Promise<ProjectGitState> =>
    request(`/projects/${id(projectId)}/git`),
  projectGitCheckout: (projectId: string, branch: string): Promise<ProjectGitResult> =>
    request(`/projects/${id(projectId)}/git/checkout`, json("POST", { branch })),
  projectGitFetch: (projectId: string, remote?: string | null): Promise<ProjectGitResult> =>
    request(`/projects/${id(projectId)}/git/fetch`, json("POST", { remote: remote ?? null })),
  projectGitPull: (projectId: string, strategy: PullStrategy): Promise<ProjectGitResult> =>
    request(`/projects/${id(projectId)}/git/pull`, json("POST", { strategy })),
  projectGitPush: (projectId: string, remote?: string | null): Promise<ProjectGitResult> =>
    request(`/projects/${id(projectId)}/git/push`, json("POST", { remote: remote ?? null })),

  // 项目的 git 配置：提交署名 / SSH key 落在**仓库自己的 .git/config**（agent 和用户的
  // 终端看到的是同一份），HTTPS 用户名+令牌落在 ash 的库里且只写不读。
  projectGitConfig: (projectId: string): Promise<ProjectGitConfig> =>
    request(`/projects/${id(projectId)}/git-config`),
  saveProjectGitConfig: (projectId: string, patch: ProjectGitConfigPatch): Promise<ProjectGitConfig> =>
    request(`/projects/${id(projectId)}/git-config`, json("PUT", patch)),
  // `secret` 留空 = 沿用已存的令牌（界面读不回旧值，只改用户名时不该逼用户重填）。
  saveProjectGitCredential: (
    projectId: string,
    username: string,
    secret: string,
  ): Promise<ProjectGitConfig> =>
    request(`/projects/${id(projectId)}/git-credential`, json("PUT", { username, secret })),
  deleteProjectGitCredential: (projectId: string): Promise<ProjectGitConfig> =>
    request(`/projects/${id(projectId)}/git-credential`, json("DELETE")),
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

  // 列表不带正文（见 shared 的 TaskListItem）；正文走 api.task(id)。
  tasks: (): Promise<TaskListItem[]> => request("/tasks"),
  task: (taskId: string): Promise<Task> => request(`/tasks/${id(taskId)}`),
  // 侧边栏铺开那一下才调：一批任务各自「我发的最后一条追问」。没有的任务不在返回里。
  followUps: (taskIds: string[]): Promise<TaskFollowUp[]> =>
    request("/tasks/follow-ups", json("POST", { taskIds })),
  // 同上，铺开的「原始需求」列按需取正文（列表接口不带它）。
  taskBodies: (taskIds: string[]): Promise<{ taskId: string; body: string }[]> =>
    request("/tasks/bodies", json("POST", { taskIds })),
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
    request(`/tasks/${id(taskId)}`, {
      ...json("PATCH", patch),
      headers: { "content-type": "application/json", "x-ash-user-action": "1" },
    }),
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
  // 「我现在动它，会不会被换掉执行器」。列表:duet 两位讨论者各占一格。
  // 多人模式的共享项目里才可能非空；自用模式恒为空数组。
  executorPreflight: (taskId: string): Promise<{ downgrades: ExecutorDowngradeItem[] }> =>
    request(`/tasks/${id(taskId)}/executor-preflight`),
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

  // 任务接力(跨机器 handoff)那一族在 `handoffApi.ts` —— 整份 spread 进来,
  // `api.handoffPeers()` 这类调用点一字不动。
  ...handoffApi,

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
  // 跟 `taskScmDiff` 是两个问题，别混：那个读的是工作目录此刻还没提交的东西（索引 + 工作树），
  // 这个读的是提交历史上的一段区间。同一个文件两边的内容可以完全不同，路径也不通用。
  taskBranchFileDiff: (taskId: string, path: string, origPath?: string | null): Promise<TaskFileDiffResult> =>
    request(`/tasks/${id(taskId)}/diff/file?path=${id(path)}${origPath ? `&origPath=${id(origPath)}` : ""}`),
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
  scmPush: (taskId: string, remote: string | null, force = false): Promise<ScmPushResult> =>
    request(`/tasks/${id(taskId)}/scm/push`, json("POST", { remote, force })),

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

  /**
   * 流式搜索：命中一条回调一条，本项目那一段扫完时回调一次 `onLocalDone`。
   *
   * 语料 2.2 GB，一次全盘扫要几秒。整份返回意味着这几秒里 ⌘K 是空的；边扫边出意味着
   * 本项目的命中第一时间就在列表里了。**`signal` 不是可选的礼貌** —— 用户每敲一个字就是
   * 一次新的全盘扫，不中断上一次，服务端会同时跑几十个扫描，把事件循环占死。
   */
  searchStream: async (
    query: string,
    scope: { projectId?: string; type?: "tasks" | "notes"; prefer?: string | null } | undefined,
    handlers: { onHit: (hit: SearchHit) => void; onLocalDone?: () => void },
    signal: AbortSignal,
  ): Promise<void> => {
    const response = await fetch(apiPath(`/search/stream?${searchQueryParams(query, scope)}`), { signal });
    if (!response.ok || !response.body) throw new Error(`搜索失败（${response.status}）`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const take = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: SearchStreamLine;
      try {
        parsed = JSON.parse(trimmed) as SearchStreamLine;
      } catch {
        return; // 半行/坏行:丢掉这一条，别把整条流拆了
      }
      if ("marker" in parsed) {
        if (parsed.marker === "local-done") handlers.onLocalDone?.();
        return;
      }
      handlers.onHit(parsed);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) take(line);
    }
    take(buffered);
  },
  // 上传走带进度的通道（postWithProgress）：粘贴一张图在远程访问时可能要传十几秒，
  // 调用方得拿到百分比才能把「正在传」说清楚。
  uploadFile: (
    dataUrl: string,
    name: string,
    options?: { onProgress?: (fraction: number) => void; signal?: AbortSignal },
  ): Promise<{ id: string; path: string; url: string; name: string; kind: AttachmentKind }> =>
    postWithProgress("/uploads", { dataUrl, name }, options),

  agents: (): Promise<AgentExecutorProfile[]> => request("/agents"),
  detectAgents: (): Promise<
    { type: AgentType; bin: string; available: boolean; path: string | null; version: string | null; resident: boolean }[]
  > => request("/agents/detect"),
  detectClis: (): Promise<DetectedCli[]> => request("/agents/catalog"),
  // ash 起 CLI 时子进程会看到的环境事实(只读)。设置页拿它算压缩触发点 ——
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
  steerScheduledMessage: (messageId: string): Promise<{ steered: true; messageId: string }> =>
    request(`/scheduled-messages/${id(messageId)}/steer`, json("POST", {})),

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
    context1m?: boolean;
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
    context1mModels?: string[];
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
      context1mModels: string[];
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
