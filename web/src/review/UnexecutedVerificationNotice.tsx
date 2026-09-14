import { useEffect, useState } from "react";
import type { TaskListItem } from "@ash/shared";
import type { UnexecutedVerification } from "@ash/shared/workflow-policy";
import { api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";

export function useAcceptanceVerification(task: TaskListItem, confirming: boolean) {
  const [snapshot, setSnapshot] = useState<{ key: string; verification: UnexecutedVerification | null; commitDefault: boolean | null; error: string | null } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [workersVersion, setWorkersVersion] = useState(0);
  const needed = task.stage !== "accepted" && (task.mode === "team" || !!task.workflow?.steps.some(step => step.kind === "verify"));
  useServerEvents(event => {
    if (task.mode === "team" && (event.type === "task.created" || event.type === "task.updated")
      && event.task.parentId === task.id && !event.task.useWorktree) setWorkersVersion(version => version + 1);
  });
  const key = `${task.id}:${task.updatedAt}:${confirming}:${workersVersion}`;
  // 确认框一打开就拉一次，哪怕这条线根本没有验证站：那一下同时带回「合并后提交代码」
  // 这一勾的项目默认值，而那个勾对任何会合并的任务都要显示。
  const wanted = needed || confirming;
  useEffect(() => {
    setAcknowledged(false);
    if (!wanted) return;
    let alive = true;
    api.acceptanceCheck(task.id).then(
      result => { if (alive) setSnapshot({ key, verification: result.verification, commitDefault: result.commitDefault !== false, error: null }); },
      error => { if (alive) setSnapshot({ key, verification: null, commitDefault: null, error: String(error) }); },
    );
    return () => { alive = false; };
  }, [key, wanted, task.id]);
  const current = snapshot?.key === key ? snapshot : null;
  return {
    verification: needed ? current?.verification ?? null : null,
    loading: needed && !current,
    error: needed ? current?.error ?? null : null,
    // null = 还没读到项目设置。读到之前一律按「会提交」显示，跟后端不传 commit 时的
    // 行为一致（后端那时读项目设置，默认就是提交）。
    commitDefault: current?.commitDefault ?? null,
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
