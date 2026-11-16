import { useState } from "react";
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

export function readDispatchFolds(rootId: string): ReadonlyMap<string, boolean> {
  let folds = new Map<string, boolean>();
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey(rootId)) ?? "[]");
    const entries = Array.isArray(saved) ? saved : (saved as { folds?: unknown } | null)?.folds;
    if (Array.isArray(entries)) folds = new Map(entries.filter((entry) => Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "boolean"));
  } catch {}
  return folds;
}

export function writeDispatchFolds(rootId: string, folds: ReadonlyMap<string, boolean>) {
  try { sessionStorage.setItem(storageKey(rootId), JSON.stringify({ folds: [...folds] })); } catch {}
}

export function useDispatchFolds(rootId: string, children: ReadonlyMap<string, readonly TaskListItem[]>, selectedId: string) {
  const initial = () => {
    const manual = readDispatchFolds(rootId);
    return { rootId, selectedId, manual, folds: revealDispatchSelection(manual, children, selectedId) };
  };
  const [state, setState] = useState(initial);
  if (state.rootId !== rootId || state.selectedId !== selectedId) setState(initial());
  const toggle = (id: string, open: boolean) => {
    const manual = new Map(state.manual).set(id, !open);
    writeDispatchFolds(rootId, manual);
    setState({ ...state, manual, folds: new Map(state.folds).set(id, !open) });
  };
  return { folds: state.folds, toggle };
}

export type DispatchFoldState = ReturnType<typeof useDispatchFolds>;
