import type { Project, ProjectView, ProjectHealth, Task, Session, Group, GateAction, Schedule, ScheduledMessage, AgentExecutorProfile, BatchCreateTasksBody, AgentType, DebateSpeaker, AttachmentKind, Issue, IssueComment, AiBackend, LlmProvider, LlmProtocol } from "@harness/shared";

const j = async (r: Response) => {
  if (!r.ok) {
    // 后端错误统一是 {error: "人话"};解析出来给 toast 用,免得用户看到
    // `409 {"error":...}` 这种原始串。解析不了再退回原始文本。
    const text = await r.text();
    let msg = `${r.status} ${text}`;
    try {
      const body = JSON.parse(text);
      if (body?.error) msg = body.error;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return r.json();
};

export const api = {
  projects: (): Promise<ProjectView[]> => fetch("/api/projects").then(j),
  createProject: (name: string, repoPath: string): Promise<ProjectView> =>
    fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, repoPath }),
    }).then(j),
  // Find-or-create a project by repoPath (idempotent, agent-friendly).
  resolveProject: (repoPath: string, name?: string): Promise<ProjectView> =>
    fetch("/api/projects/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoPath, name }),
    }).then(j),
  updateProject: (id: string, patch: Partial<Pick<Project, "name" | "repoPath">>): Promise<ProjectView> =>
    fetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then(j),
  deleteProject: (id: string): Promise<unknown> =>
    fetch(`/api/projects/${id}`, { method: "DELETE" }).then(j),
  projectHealth: (id: string): Promise<ProjectHealth> =>
    fetch(`/api/projects/${id}/health`).then(j),
  // Local branches + current HEAD — drives the "base 分支" picker on the new-task
  // form when worktree is toggled on. Empty list ⇒ not a git repo / not yet
  // initialized; the picker falls back to a text input.
  projectBranches: (id: string): Promise<{ branches: string[]; current: string | null }> =>
    fetch(`/api/projects/${id}/branches`).then(j),
  // One-click "清理 worktree" — wraps `git worktree remove [--force] <path>`.
  // Called from the delete-task confirmation; throws on dirty unless force=true.
  removeWorktree: (projectId: string, path: string, force = false): Promise<{ removed: true }> =>
    fetch(`/api/projects/${projectId}/worktrees/remove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, force }),
    }).then(j),
  checkPath: (repoPath: string): Promise<ProjectHealth> =>
    fetch("/api/projects/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoPath }),
    }).then(j),

  groups: (projectId?: string): Promise<Group[]> =>
    fetch(`/api/groups${projectId ? `?projectId=${projectId}` : ""}`).then(j),
  // Create a group. projectId locates the project; repoPath is an agent-friendly
  // alternative (resolved server-side). One of the two is required.
  createGroup: (g: Partial<Group> & { name: string; projectId?: string; repoPath?: string }): Promise<Group> =>
    fetch("/api/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(g),
    }).then(j),
  runGroup: (id: string): Promise<unknown> =>
    fetch(`/api/groups/${id}/run`, { method: "POST" }).then(j),
  // Pause a group: holds not-yet-started tasks AND stops the running one (it
  // settles as canceled, resumable). Resume by running the group again — the
  // stopped task picks up from where it left off. Returns the group (paused=true).
  pauseGroup: (id: string): Promise<Group> =>
    fetch(`/api/groups/${id}/pause`, { method: "POST" }).then(j),
  // Batch-create chained single tasks into an existing group (agent-facing API).
  createTasksBatch: (
    groupId: string,
    body: BatchCreateTasksBody,
  ): Promise<{ groupId: string; run: boolean; tasks: Task[] }> =>
    fetch(`/api/groups/${groupId}/tasks/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(j),
  updateGroup: (id: string, patch: Partial<Pick<Group, "name" | "mode">>): Promise<Group> =>
    fetch(`/api/groups/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then(j),
  deleteGroup: (id: string): Promise<unknown> =>
    fetch(`/api/groups/${id}`, { method: "DELETE" }).then(j),

  tasks: (): Promise<Task[]> => fetch("/api/tasks").then(j),
  task: (id: string): Promise<Task> => fetch(`/api/tasks/${id}`).then(j),
  // Persist a pasted image/file; returns its absolute path (for the agent), a url
  // (preview) and the kind (image vs file → which chip the composer shows).
  uploadFile: (dataUrl: string, name: string): Promise<{ id: string; path: string; url: string; name: string; kind: AttachmentKind }> =>
    fetch("/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl, name }),
    }).then(j),
  createTask: (t: Partial<Task> & { projectId: string; title: string; attachments?: string[] }): Promise<Task> =>
    fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(t),
    }).then(j),
  patchTask: (id: string, patch: Partial<Task>): Promise<Task> =>
    fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then(j),
  deleteTask: (id: string): Promise<{ deleted: true; worktreeHint?: { path: string; branch: string } | null }> =>
    fetch(`/api/tasks/${id}`, { method: "DELETE" }).then(j),
  runTask: (id: string): Promise<unknown> =>
    fetch(`/api/tasks/${id}/run`, { method: "POST" }).then(j),
  stopTask: (id: string): Promise<unknown> =>
    fetch(`/api/tasks/${id}/stop`, { method: "POST" }).then(j),
  retryTask: (id: string): Promise<unknown> =>
    fetch(`/api/tasks/${id}/retry`, { method: "POST" }).then(j),
  archiveTask: (id: string): Promise<Task> =>
    fetch(`/api/tasks/${id}/archive`, { method: "POST" }).then(j),
  unarchiveTask: (id: string): Promise<Task> =>
    fetch(`/api/tasks/${id}/unarchive`, { method: "POST" }).then(j),
  replyTask: (id: string, text: string, opts?: { attachments?: string[]; agent?: AgentType; sendAt?: string }): Promise<unknown> =>
    fetch(`/api/tasks/${id}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ...opts }),
    }).then(j),
  gate: (id: string, action: GateAction): Promise<unknown> =>
    fetch(`/api/tasks/${id}/gate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
    }).then(j),

  schedule: (taskId: string): Promise<Schedule | null> =>
    fetch(`/api/tasks/${taskId}/schedule`).then(j),
  setSchedule: (
    taskId: string,
    s: { kind: "once" | "cron"; at?: string | null; cron?: string | null },
  ): Promise<Schedule> =>
    fetch(`/api/tasks/${taskId}/schedule`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(s),
    }).then(j),
  clearSchedule: (taskId: string): Promise<unknown> =>
    fetch(`/api/tasks/${taskId}/schedule`, { method: "DELETE" }).then(j),

  // Scheduled replies (定时发送): list this task's pending ones; cancel by message id.
  scheduledMessages: (taskId: string): Promise<ScheduledMessage[]> =>
    fetch(`/api/tasks/${taskId}/scheduled-messages`).then(j),
  cancelScheduledMessage: (mid: string): Promise<unknown> =>
    fetch(`/api/scheduled-messages/${mid}`, { method: "DELETE" }).then(j),

  agents: (): Promise<AgentExecutorProfile[]> => fetch("/api/agents").then(j),
  detectAgents: (): Promise<
    { type: string; bin: string; available: boolean; path: string | null; version: string | null }[]
  > => fetch("/api/agents/detect").then(j),
  createAgent: (a: Partial<AgentExecutorProfile>): Promise<AgentExecutorProfile> =>
    fetch("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(a),
    }).then(j),
  patchAgent: (id: string, a: Partial<AgentExecutorProfile>): Promise<AgentExecutorProfile> =>
    fetch(`/api/agents/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(a),
    }).then(j),
  deleteAgent: (id: string): Promise<unknown> =>
    fetch(`/api/agents/${id}`, { method: "DELETE" }).then(j),

  sessions: (taskId: string): Promise<Session[]> =>
    fetch(`/api/tasks/${taskId}/sessions`).then(j),
  sessionOutput: (id: string): Promise<string> =>
    fetch(`/api/sessions/${id}/output`).then((r) => r.text()),
  debateTranscript: (
    taskId: string,
  ): Promise<{ round: number; speaker: DebateSpeaker; text: string; raised?: boolean; agrees?: boolean; conclusion?: string; error?: string; at?: string; target?: "A" | "B" }[]> =>
    fetch(`/api/tasks/${taskId}/debate`).then(j),

  // ── issues (planning/discussion layer; see shared Issue) ───────────────────
  issues: (projectId?: string): Promise<Issue[]> =>
    fetch(`/api/issues${projectId ? `?projectId=${projectId}` : ""}`).then(j),
  // Create from raw text — parsing is synchronous (the composer shows 「识别中…」
  // until this resolves). backend = which AI parses; projectId pins a project
  // (else the AI infers it; null/unset → 未归类 staging).
  createIssue: (body: { text: string; backend?: AiBackend | null; projectId?: string | null; attachments?: string[] }): Promise<Issue> =>
    fetch("/api/issues", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(j),
  patchIssue: (id: string, patch: Partial<Issue>): Promise<Issue> =>
    fetch(`/api/issues/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }).then(j),
  deleteIssue: (id: string): Promise<unknown> =>
    fetch(`/api/issues/${id}`, { method: "DELETE" }).then(j),
  issueComments: (id: string): Promise<IssueComment[]> =>
    fetch(`/api/issues/${id}/comments`).then(j),
  // Post a comment. Plain = discussion. With `mention` (a CLI agentType) the
  // server classifies intent: "execute" derives a task (returns task); "discuss"
  // spawns a one-shot CLI reply and returns a pending agent comment that gets
  // filled in by polling (the discussion view refreshes while status=pending).
  postIssueComment: (id: string, body: { body: string; mention?: AgentType; attachments?: string[]; useWorktree?: boolean }): Promise<{ comment: IssueComment; task?: Task; agentComment?: IssueComment }> =>
    fetch(`/api/issues/${id}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(j),
  patchIssueComment: (issueId: string, cid: string, patch: { body?: string; attachments?: string[] }): Promise<IssueComment> =>
    fetch(`/api/issues/${issueId}/comments/${cid}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }).then(j),
  deleteIssueComment: (issueId: string, cid: string): Promise<unknown> =>
    fetch(`/api/issues/${issueId}/comments/${cid}`, { method: "DELETE" }).then(j),
  issueTasks: (id: string): Promise<Task[]> =>
    fetch(`/api/issues/${id}/tasks`).then(j),
  // Commits a derived task produced on its worktree branch (issue → code linkage).
  taskCommits: (id: string): Promise<{ branch: string | null; commits: { sha: string; subject: string; at: string }[] }> =>
    fetch(`/api/tasks/${id}/commits`).then(j),
  // Direct-LLM connections (中转站, system-level) — issue parsing only. List never
  // returns the key (hasKey flag only); send apiKey only when setting/changing it.
  llmProviders: (): Promise<LlmProvider[]> => fetch("/api/llm-providers").then(j),
  // Probe available models for a connection (ad-hoc creds, or `id` to reuse a
  // stored key). Used by 设置 to pick a default model.
  probeModels: (body: { protocol: LlmProtocol; baseUrl: string; apiKey?: string; id?: string }): Promise<{ models: string[] }> =>
    fetch("/api/llm-providers/models", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(j),
  createLlmProvider: (p: { name: string; protocol: LlmProtocol; baseUrl: string; apiKey: string; model: string }): Promise<LlmProvider> =>
    fetch("/api/llm-providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) }).then(j),
  patchLlmProvider: (id: string, p: Partial<{ name: string; protocol: LlmProtocol; baseUrl: string; apiKey: string; model: string }>): Promise<LlmProvider> =>
    fetch(`/api/llm-providers/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(p) }).then(j),
  deleteLlmProvider: (id: string): Promise<unknown> =>
    fetch(`/api/llm-providers/${id}`, { method: "DELETE" }).then(j),
  // Queue ops (DESIGN-scheduling.md §1):任务在某个 queue 里的位置决定调度顺序。
  // 这里只暴露查/改;创建队列通过 batch_create_tasks(chain:true) 或 create_queue
  // 端点(后端走 MCP),前端用户不直接建队列。
  queue: (qid: string): Promise<{
    queueId: string;
    groupId: string | null;
    items: { taskId: string; position: number; title: string; status: string | null; archived: boolean }[];
  }> => fetch(`/api/queues/${qid}`).then(j),
  queueReorder: (qid: string, taskIds: string[]): Promise<{ ok: true }> =>
    fetch(`/api/queues/${qid}/reorder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskIds }) }).then(j),
  queueRemove: (qid: string, taskId: string): Promise<{ ok: true }> =>
    fetch(`/api/queues/${qid}/remove`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId }) }).then(j),
};
