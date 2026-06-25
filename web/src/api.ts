import type { Project, ProjectView, ProjectHealth, Task, Session, Group, GateAction, Schedule, ScheduledMessage, AgentExecutorProfile, BatchCreateTasksBody, AgentType, DebateSpeaker, AttachmentKind, Issue, IssueComment, AiBackend } from "@harness/shared";

const j = async (r: Response) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
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
  createIssue: (body: { text: string; backend?: AiBackend | null; projectId?: string | null }): Promise<Issue> =>
    fetch("/api/issues", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(j),
  patchIssue: (id: string, patch: Partial<Issue>): Promise<Issue> =>
    fetch(`/api/issues/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }).then(j),
  deleteIssue: (id: string): Promise<unknown> =>
    fetch(`/api/issues/${id}`, { method: "DELETE" }).then(j),
  issueComments: (id: string): Promise<IssueComment[]> =>
    fetch(`/api/issues/${id}/comments`).then(j),
  // Post a comment. Plain = discussion. With `mention` (a CLI agentType) it ALSO
  // executes: derives a task carrying title + body + the whole thread.
  postIssueComment: (id: string, body: { body: string; mention?: AgentType }): Promise<{ comment: IssueComment; task?: Task }> =>
    fetch(`/api/issues/${id}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(j),
  issueTasks: (id: string): Promise<Task[]> =>
    fetch(`/api/issues/${id}/tasks`).then(j),
  // Project API keys for direct-LLM parsing. GET returns only presence flags.
  projectApiKeys: (id: string): Promise<{ anthropic: boolean; openai: boolean }> =>
    fetch(`/api/projects/${id}/api-keys`).then(j),
  setProjectApiKeys: (id: string, keys: { anthropic?: string; openai?: string }): Promise<unknown> =>
    fetch(`/api/projects/${id}/api-keys`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(keys) }).then(j),
};
