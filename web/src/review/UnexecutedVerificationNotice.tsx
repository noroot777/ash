import { useEffect, useState } from "react";
import type { TaskListItem } from "@ash/shared";
import type { UnexecutedVerification } from "@ash/shared/workflow-policy";
import { api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";

export function useAcceptanceVerification(task: TaskListItem, confirming: boolean) {
  const [snapshot, setSnapshot] = useState<{ key: string; verification: UnexecutedVerification | null; error: string | null } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [workersVersion, setWorkersVersion] = useState(0);
  const needed = task.stage !== "accepted" && (task.mode === "team" || !!task.workflow?.steps.some(step => step.kind === "verify"));
  useServerEvents(event => {
    if (task.mode === "team" && (event.type === "task.created" || event.type === "task.updated")
      && event.task.parentId === task.id && !event.task.useWorktree) setWorkersVersion(version => version + 1);
  });
  const key = `${task.id}:${task.updatedAt}:${confirming}:${workersVersion}`;
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
  };
}

export function UnexecutedVerificationNotice({ verification, continuing = false, checked, onChange }: {
  verification: UnexecutedVerification;
  continuing?: boolean;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  return <div className="team-accept-failure" role="note">
    <b>独立验证尚未执行</b>
    <p>{verification.message}{continuing ? " 放行后会按工作流继续推进至验证站。" : " 你仍可决定验收；这不会将验证标记为已通过。"}</p>
    {onChange && <label><input type="checkbox" checked={checked ?? false} onChange={e => onChange(e.target.checked)} />我已知晓独立验证尚未执行，仍要验收</label>}
  </div>;
}
