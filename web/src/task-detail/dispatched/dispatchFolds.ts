import { useState } from "react";

const storageKey = (rootId: string) => `ash:subtasks:folds:${rootId}`;

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

export function useDispatchFolds(rootId: string) {
  const initial = () => ({ rootId, folds: readDispatchFolds(rootId) });
  const [state, setState] = useState(initial);
  if (state.rootId !== rootId) setState(initial());
  const toggle = (id: string, open: boolean) => {
    const folds = new Map(state.folds).set(id, !open);
    writeDispatchFolds(rootId, folds);
    setState({ rootId, folds });
  };
  return { folds: state.folds, toggle };
}

export type DispatchFoldState = ReturnType<typeof useDispatchFolds>;
