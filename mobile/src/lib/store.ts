// Global app state (zustand). Mirrors the state + SSE-event handling that lives
// in web/src/App.tsx, condensed to the single-task surface. The SSE layer calls
// `handleEvent`; screens subscribe to slices and re-render.
import { create } from "zustand";
import type { ProjectView, Task, ServerEvent } from "@harness/shared";
import { renderEvent, type LogLine } from "./log";

interface State {
  connected: boolean;
  projects: ProjectView[];
  projectId: string | null;
  tasks: Task[];
  logs: Record<string, LogLine[]>;
  sessionsBump: number; // bumped on terminal status → detail re-pulls sessions
  streamEpoch: number; // bumped on every SSE (re)connect → detail re-pulls .md to fill gaps missed while offline

  setConnected: (b: boolean) => void;
  setProjects: (p: ProjectView[]) => void;
  setProjectId: (id: string | null) => void;
  setTasks: (t: Task[]) => void;
  upsertTask: (t: Task) => void;
  removeTask: (id: string) => void;
  clearLogs: (id: string) => void;
  appendUser: (id: string, text: string) => void;
  handleEvent: (ev: ServerEvent) => void;
}

export const useStore = create<State>((set) => ({
  connected: false,
  projects: [],
  projectId: null,
  tasks: [],
  logs: {},
  sessionsBump: 0,
  streamEpoch: 0,

  // Every (re)connect bumps streamEpoch — and we bump on each `true`, not only a
  // false→true flip: a phone can hold a dead-but-undetected socket, so the detail
  // screen must re-reconcile from .md on every fresh open() regardless of the
  // prior connected value.
  setConnected: (connected) =>
    set((s) => ({ connected, streamEpoch: connected ? s.streamEpoch + 1 : s.streamEpoch })),
  setProjects: (projects) => set({ projects }),
  setProjectId: (projectId) => set({ projectId }),
  setTasks: (tasks) => set({ tasks }),
  upsertTask: (t) =>
    set((s) => ({
      tasks: s.tasks.some((x) => x.id === t.id) ? s.tasks.map((x) => (x.id === t.id ? t : x)) : [t, ...s.tasks],
    })),
  removeTask: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
  clearLogs: (id) => set((s) => ({ logs: { ...s.logs, [id]: [] } })),
  appendUser: (id, text) =>
    set((s) => ({
      logs: { ...s.logs, [id]: [...(s.logs[id] ?? []), { kind: "user", text, at: new Date().toISOString() }] },
    })),

  handleEvent: (ev: ServerEvent) =>
    set((s) => {
      if (ev.type === "task.status") {
        const tasks = s.tasks.map((t) =>
          t.id === ev.taskId
            ? {
                ...t,
                status: ev.status,
                startedAt: ev.startedAt !== undefined ? ev.startedAt : t.startedAt,
                endedAt: ev.endedAt !== undefined ? ev.endedAt : t.endedAt,
              }
            : t,
        );
        const terminal = ev.status === "done" || ev.status === "failed" || ev.status === "canceled";
        return { tasks, sessionsBump: terminal ? s.sessionsBump + 1 : s.sessionsBump };
      }
      if (ev.type === "task.title") {
        return { tasks: s.tasks.map((t) => (t.id === ev.taskId ? { ...t, title: ev.title } : t)) };
      }
      if (ev.type === "agent.event" && ev.role === "single") {
        const line = renderEvent(ev.event, ev.agentType, ev.sessionId);
        if (!line) return {};
        return { logs: { ...s.logs, [ev.taskId]: [...(s.logs[ev.taskId] ?? []), line] } };
      }
      return {}; // debate.* and non-single agent.events are ignored on mobile
    }),
}));
