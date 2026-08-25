// Global app state (zustand): the projects/tasks that the polling layer keeps
// fresh. The mobile client pulls over plain REST on a timer — no SSE — so this
// store is just the shared cache those polls write into, plus an `online` flag
// (did the last sync reach the backend?) for the drawer's connection dot.
// Conversation content is NOT here: the task screen owns it locally, polled from
// the session .md (see app/task/[id].tsx).
import { create } from "zustand";
import type { ProjectView, TaskListItem, Group } from "@ash/shared";

interface State {
  online: boolean;
  projects: ProjectView[];
  projectId: string | null;
  tasks: TaskListItem[];
  groups: Group[];

  setOnline: (b: boolean) => void;
  setProjects: (p: ProjectView[]) => void;
  setProjectId: (id: string | null) => void;
  setTasks: (t: TaskListItem[]) => void;
  upsertTask: (t: TaskListItem) => void;
  removeTask: (id: string) => void;
  setGroups: (g: Group[]) => void;
  upsertGroup: (g: Group) => void;
  removeGroup: (id: string) => void;
}

export const useStore = create<State>((set) => ({
  online: false,
  projects: [],
  projectId: null,
  tasks: [],
  groups: [],

  setOnline: (online) => set({ online }),
  setProjects: (projects) => set({ projects }),
  setProjectId: (projectId) => set({ projectId }),
  setTasks: (tasks) => set({ tasks }),
  upsertTask: (t) =>
    set((s) => ({
      tasks: s.tasks.some((x) => x.id === t.id) ? s.tasks.map((x) => (x.id === t.id ? t : x)) : [t, ...s.tasks],
    })),
  removeTask: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
  setGroups: (groups) => set({ groups }),
  upsertGroup: (g) =>
    set((s) => ({
      groups: s.groups.some((x) => x.id === g.id) ? s.groups.map((x) => (x.id === g.id ? g : x)) : [...s.groups, g],
    })),
  removeGroup: (id) => set((s) => ({ groups: s.groups.filter((g) => g.id !== id) })),
}));
