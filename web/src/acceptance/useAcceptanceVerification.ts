import { useEffect, useState } from "react";
import type { TaskListItem } from "@ash/shared";
import type { UnexecutedVerification } from "@ash/shared/workflow-policy";
import { api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";

/**
 * 这一按之前要不要先勾「知情」：工作流里有验证站（或团队）却没真跑过独立验证。读不到一律
 * 不放行（loading / error 都让确认键灰着）。
 */
export function useAcceptanceVerification(task: TaskListItem, confirming: boolean) {
  const [snapshot, setSnapshot] = useState<{ key: string; verification: UnexecutedVerification | null; error: string | null } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [workersVersion, setWorkersVersion] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const needed = task.stage !== "accepted" && (task.mode === "team" || !!task.workflow?.steps.some(step => step.kind === "verify"));
  useServerEvents(event => {
    if (task.mode === "team" && (event.type === "task.created" || event.type === "task.updated")
      && event.task.parentId === task.id && !event.task.useWorktree) setWorkersVersion(version => version + 1);
  });
  const key = `${task.id}:${task.updatedAt}:${confirming}:${workersVersion}:${attempt}`;
  useEffect(() => {
    setAcknowledged(false);
    if (!needed) return;
    let alive = true;
    api.acceptanceCheck(task.id).then(
      result => { if (alive) setSnapshot({ key, verification: result.verification, error: null }); },
      error => { if (alive) setSnapshot({ key, verification: null, error: String(error) }); },
    );
    return () => { alive = false; };
  }, [key, needed, task.id]);
  const current = snapshot?.key === key ? snapshot : null;
  return {
    verification: needed ? current?.verification ?? null : null,
    loading: needed && !current,
    error: needed ? current?.error ?? null : null,
    acknowledged, setAcknowledged,
    reload: () => setAttempt((n) => n + 1),
  };
}
