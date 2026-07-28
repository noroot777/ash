import { useEffect, useMemo, useState } from "react";
import type { Task } from "@harness/shared";

const STORAGE_KEY = "harness:taskList:readWatermarks";

type ReadWatermarks = Record<string, number>;

function loadReadWatermarks(): ReadWatermarks {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

function saveReadWatermarks(watermarks: ReadWatermarks) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(watermarks));
  } catch {
    /* private mode / quota — unread state just won't persist */
  }
}

function updatedAtMs(task: Task): number {
  const timestamp = Date.parse(task.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function latestTeamActivity(tasks: Task[]): Map<string, number> {
  const teamIds = new Set(
    tasks.filter((task) => task.mode === "team" && !task.parentId).map((task) => task.id),
  );
  const latest = new Map<string, number>();

  for (const task of tasks) {
    const teamId = teamIds.has(task.id) ? task.id : task.parentId;
    if (!teamId || !teamIds.has(teamId)) continue;
    latest.set(teamId, Math.max(latest.get(teamId) ?? 0, updatedAtMs(task)));
  }

  return latest;
}

export function useUnreadTeamTasks(tasks: Task[], selected: string | null): Set<string> {
  const [readWatermarks, setReadWatermarks] = useState<ReadWatermarks>(loadReadWatermarks);
  const latestByTeam = useMemo(() => latestTeamActivity(tasks), [tasks]);

  useEffect(() => {
    setReadWatermarks((current) => {
      let next = current;

      for (const [taskId, latest] of latestByTeam) {
        if (current[taskId] == null || (selected === taskId && latest > current[taskId])) {
          if (next === current) next = { ...current };
          next[taskId] = latest;
        }
      }

      if (next !== current) saveReadWatermarks(next);
      return next;
    });
  }, [latestByTeam, selected]);

  return new Set(
    [...latestByTeam].flatMap(([taskId, latest]) =>
      selected !== taskId && readWatermarks[taskId] != null && latest > readWatermarks[taskId]
        ? [taskId]
        : [],
    ),
  );
}
