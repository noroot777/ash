import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task, TaskListItem } from "@ash/shared";
import { AuthContext } from "../../src/auth/authContext.ts";
import { TaskReviewWorkspace } from "../../src/review/TaskReviewWorkspace.tsx";
import { TeamReviewWorkspace } from "../../src/team/TeamReviewWorkspace.tsx";
import "../../src/styles/global.css";

// 验收台的事实跟着任务版本走、出路都按得到（判据与来由见 test-acceptance-freshness.mjs）。
// /api/** 全由测试脚本答；这一页只摆真宿主，并把「任务更新了」「打回之后回到哪」两件事露给脚本。
window.EventSource = class { close() {} addEventListener() {} removeEventListener() {} } as unknown as typeof EventSource;

const base = {
  projectId: "proj-1", body: "", labels: [], dependsOn: [], resumeDependsOn: [], agentType: "claude",
  mode: "single", status: "done", stage: "awaiting_acceptance", useWorktree: true, workflowMode: null, workflow: null,
  parentId: null, archived: false, mergeTargetBranch: "main", worktreeBase: "main",
  createdAt: "2026-11-02T01:03:00.000Z", updatedAt: "2026-11-02T01:24:00.000Z",
};
const task = (id: string, title: string, extra: Record<string, unknown> = {}) =>
  ({ ...base, id, title, ...extra }) as unknown as Task;

const lead = task("team-lead", "团队验收", { mode: "team" });
const pending = task("pending-task", "合并后不提交", { stage: "accepted", acceptedMergeMethod: "no_commit", acceptedMergeCommit: null,
  acceptedTargetBranch: "main" });
const workers = [task("indie-worker", "独立执行者", { parentId: "team-lead", status: "done", stage: null })] as TaskListItem[];

declare global {
  interface Window {
    bumpSingle: (patch: Record<string, unknown>) => void;
    returned: string[];
  }
}
window.returned = [];

function Single() {
  const [current, setCurrent] = useState(task("single-task", "验收台"));
  window.bumpSingle = (patch) => setCurrent((value) => ({ ...value, ...patch, updatedAt: new Date().toISOString() }));
  return <TaskReviewWorkspace task={current} allTasks={[current]} onTaskUpdated={() => {}} notify={() => {}} onClose={() => window.returned.push("single")} />;
}

function Fixture() {
  return <AuthContext.Provider value={{ state: { mode: "single", user: null, needsSetup: false }, refresh: async () => {} }}>
    <div data-host="single" style={{ display: "flex", flexDirection: "column", height: 420 }}><Single /></div>
    <div data-host="pending" style={{ display: "flex", flexDirection: "column", height: 320 }}>
      <TaskReviewWorkspace task={pending} allTasks={[pending]} onTaskUpdated={() => {}} notify={() => {}} />
    </div>
    <div data-host="team" style={{ display: "flex", flexDirection: "column", height: 520 }}>
      <TeamReviewWorkspace lead={lead} workers={workers} onTaskUpdated={() => {}} indicatorForTask={() => null} onReadTask={() => {}}
        notify={() => {}} onReturned={(target) => window.returned.push(target.id)} />
    </div>
  </AuthContext.Provider>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
