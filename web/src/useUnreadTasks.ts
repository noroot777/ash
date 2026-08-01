import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { Task } from "@harness/shared";
import {
  advanceReadWatermarks,
  taskActivity,
  teamActivity,
  unreadTaskIds,
  type TaskActivity,
  type ReadWatermarks,
} from "./unreadTaskState";

const TEAM_STORAGE_KEY = "harness:taskList:readWatermarks";
const TASK_STORAGE_KEY = "harness:taskList:taskReadWatermarks";
const EMPTY_WATERMARKS: ReadWatermarks = {};

function loadReadWatermarks(storageKey: string): ReadWatermarks {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

function saveReadWatermarks(storageKey: string, watermarks: ReadWatermarks) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(storageKey, JSON.stringify(watermarks));
  } catch {
    /* private mode / quota — unread state just won't persist */
  }
}

type ReadStore = {
  read: () => ReadWatermarks;
  publish: (next: ReadWatermarks) => void;
  subscribe: (listener: () => void) => () => void;
};

function createReadStore(storageKey: string): ReadStore {
  const listeners = new Set<() => void>();
  let snapshot: ReadWatermarks | null = null;
  const read = () => (snapshot ??= loadReadWatermarks(storageKey));

  return {
    read,
    publish(next) {
      if (next === read()) return;
      snapshot = next;
      saveReadWatermarks(storageKey, next);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const teamStore = createReadStore(TEAM_STORAGE_KEY);
const taskStore = createReadStore(TASK_STORAGE_KEY);

function useUnreadActivity(activity: TaskActivity, selected: string | null, store: ReadStore) {
  const readWatermarks = useSyncExternalStore(store.subscribe, store.read, () => EMPTY_WATERMARKS);

  useEffect(() => {
    store.publish(advanceReadWatermarks(store.read(), activity, selected ? [selected] : []));
  }, [activity, selected, store]);

  const markRead = useCallback(
    (taskIds: Iterable<string>) => {
      store.publish(advanceReadWatermarks(store.read(), activity, taskIds));
    },
    [activity, store],
  );

  return {
    unread: useMemo(
      () => unreadTaskIds(activity, readWatermarks, selected ? [selected] : []),
      [activity, readWatermarks, selected],
    ),
    markRead,
  };
}

export function useUnreadTasks(tasks: Task[], selected: string | null) {
  return useUnreadActivity(useMemo(() => taskActivity(tasks), [tasks]), selected, taskStore);
}

export function useUnreadTeamTasks(tasks: Task[], selectedTeam: string | null) {
  return useUnreadActivity(useMemo(() => teamActivity(tasks), [tasks]), selectedTeam, teamStore);
}
