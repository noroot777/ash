import type { TaskListItem } from "@ash/shared";
import { dispatchSubtree } from "../../lib/dispatchTree.ts";
import { dispatchLevel } from "../../lib/dispatchFamily.ts";

const storageKey = (rootId: string) => `ash:subtasks:folds:${rootId}`;

export function revealDispatchSelection(folds: ReadonlyMap<string, boolean>, children: ReadonlyMap<string, readonly TaskListItem[]>, selectedId: string) {
  const next = new Map(folds);
  for (const parentId of children.keys()) {
    if (!dispatchSubtree(children, parentId).some((item) => item.id === selectedId)) continue;
    next.set(parentId, true);
    if (dispatchLevel(children, parentId, selectedId).acceptedOpen) next.set(`accepted:${parentId}`, true);
  }
  return next;
}

export function readDispatchFolds(rootId: string, children: ReadonlyMap<string, readonly TaskListItem[]>, selectedId: string): ReadonlyMap<string, boolean> {
  let folds = new Map<string, boolean>();
  let focusedId: string | null = null;
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey(rootId)) ?? "[]");
    const entries = Array.isArray(saved) ? saved : (saved as { folds?: unknown } | null)?.folds;
    if (Array.isArray(entries)) folds = new Map(entries.filter((entry) => Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "boolean"));
    if (saved && typeof saved === "object" && "focusedId" in saved && typeof saved.focusedId === "string") focusedId = saved.focusedId;
  } catch {}
  return focusedId === selectedId ? folds : revealDispatchSelection(folds, children, selectedId);
}

export function writeDispatchFolds(rootId: string, folds: ReadonlyMap<string, boolean>, focusedId?: string) {
  try { sessionStorage.setItem(storageKey(rootId), JSON.stringify({ folds: [...folds], focusedId })); } catch {}
}
