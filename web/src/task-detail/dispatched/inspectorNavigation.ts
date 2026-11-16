import type { TaskListItem } from "@ash/shared";
import { dispatchPath } from "../../lib/dispatchFamily.ts";

export type InspectorEntry = { id: string; visible: boolean };
const entries = new Map<string, InspectorEntry>();

export function rememberFamilyInspector(fromId: string | null, toId: string, tasks: readonly TaskListItem[]) {
  if (!fromId || fromId === toId) return;
  const from = tasks.find((task) => task.id === fromId);
  const to = tasks.find((task) => task.id === toId);
  if (!from || !to || dispatchPath(from, tasks)[0].id !== dispatchPath(to, tasks)[0].id) return;
  try {
    const saved = JSON.parse(localStorage.getItem(`ash:inspector:task:${fromId}`) ?? "null");
    if (typeof saved?.activeTab === "string") entries.set(toId, { id: saved.activeTab, visible: saved.visible !== false });
  } catch {}
}

export function takeInspectorEntry(taskId: string): InspectorEntry | undefined {
  return entries.get(taskId);
}

export function clearInspectorEntry(taskId: string) { entries.delete(taskId); }
