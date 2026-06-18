import type { Project, ProjectView, ProjectHealth, Task, Session, Group, GateAction, Schedule, AgentExecutorProfile, BatchCreateTasksBody, AgentType } from "@harness/shared";

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
  updateGroup: (id: string, patch: Partial<Pick<Group, "name" | "mode" | "useWorktree">>): Promise<Group> =>
    fetch(`/api/groups/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then(j),
  deleteGroup: (id: string): Promise<unknown> =>
    fetch(`/api/groups/${id}`, { method: "DELETE" }).then(j),

  tasks: (): Promise<Task[]> => fetch("/api/tasks").then(j),
  task: (id: string): Promise<Task> => fetch(`/api/tasks/${id}`).then(j),
  // Persist a pasted image; returns its absolute path (for the agent) + url (preview).
  uploadImage: (dataUrl: string): Promise<{ id: string; path: string; url: string }> =>
    fetch("/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl }),
    }).then(j),
  createTask: (t: Partial<Task> & { projectId: string; title: string; images?: string[] }): Promise<Task> =>
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
  deleteTask: (id: string): Promise<unknown> =>
    fetch(`/api/tasks/${id}`, { method: "DELETE" }).then(j),
  runTask: (id: string): Promise<unknown> =>
    fetch(`/api/tasks/${id}/run`, { method: "POST" }).then(j),
  retryTask: (id: string): Promise<unknown> =>
    fetch(`/api/tasks/${id}/retry`, { method: "POST" }).then(j),
  replyTask: (id: string, text: string, opts?: { images?: string[]; agent?: AgentType }): Promise<unknown> =>
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
  ): Promise<{ round: number; speaker: "A" | "B" | "impl"; text: string; raised: boolean; agrees?: boolean; conclusion?: string; error?: string }[]> =>
    fetch(`/api/tasks/${taskId}/debate`).then(j),
};
