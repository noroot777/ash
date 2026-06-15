import type { Project, Task, Session, Group } from "@harness/shared";

const j = async (r: Response) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};

export const api = {
  projects: (): Promise<Project[]> => fetch("/api/projects").then(j),
  createProject: (name: string, repoPath: string): Promise<Project> =>
    fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, repoPath }),
    }).then(j),

  groups: (projectId?: string): Promise<Group[]> =>
    fetch(`/api/groups${projectId ? `?projectId=${projectId}` : ""}`).then(j),
  createGroup: (g: Partial<Group> & { projectId: string; name: string }): Promise<Group> =>
    fetch("/api/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(g),
    }).then(j),

  tasks: (): Promise<Task[]> => fetch("/api/tasks").then(j),
  task: (id: string): Promise<Task> => fetch(`/api/tasks/${id}`).then(j),
  createTask: (t: Partial<Task> & { projectId: string; title: string }): Promise<Task> =>
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

  sessions: (taskId: string): Promise<Session[]> =>
    fetch(`/api/tasks/${taskId}/sessions`).then(j),
  sessionOutput: (id: string): Promise<string> =>
    fetch(`/api/sessions/${id}/output`).then((r) => r.text()),
};
