import type { BrowserObservation, BrowserUserAction, ComputerUseFrame, TaskRuntimeState } from "@navi/shared/task-runtime";
import { id, json, request } from "../lib/apiClient.ts";

export const runtimeApi = {
  state: (taskId: string) => request<TaskRuntimeState>(`/tasks/${id(taskId)}/runtime`),
  activateComputer: (taskId: string, frame: ComputerUseFrame) => request(`/tasks/${id(taskId)}/runtime/computer/activate`,
    json("POST", { sessionId: frame.sessionId, turnStartedAt: frame.turnStartedAt, application: frame.target?.application })),
  start: (taskId: string, command: string) => request(`/tasks/${id(taskId)}/runtime/service`, json("POST", { command })),
  stop: (taskId: string) => request(`/tasks/${id(taskId)}/runtime/service`, { method: "DELETE" }),
  action: (taskId: string, browserId: string | undefined, action: BrowserUserAction) =>
    request<BrowserObservation>(`/tasks/${id(taskId)}/runtime/browser`, json("POST", { ...action, id: browserId })),
};
