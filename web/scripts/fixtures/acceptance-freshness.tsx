import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task, TaskListItem } from "@ash/shared";
import { AuthContext } from "../../src/auth/authContext.ts";
import { TaskReviewWorkspace } from "../../src/review/TaskReviewWorkspace.tsx";
import { TeamReviewWorkspace } from "../../src/team/TeamReviewWorkspace.tsx";
import { mergeTaskSnapshotFields } from "../../src/lib/taskSnapshot.ts";
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
    remountSingle: () => void;
    returned: string[];
  }
}
window.returned = [];

function Single() {
  const [current, setCurrent] = useState(task("single-task", "验收台"));
  // 宿主从别处收到一份任务快照（patch 里可以带 updatedAt，模拟一份早于某次写入的中间版本）。
  window.bumpSingle = (patch) => setCurrent((value) => ({ ...value, updatedAt: new Date().toISOString(), ...patch }));
  // 读回来的任务按产品同一条单调合并落进宿主：比手上旧的不覆盖。
  const apply = (next: Task) => setCurrent((value) => mergeTaskSnapshotFields(value, { ...value, ...next }));
  return <TaskReviewWorkspace task={current} allTasks={[current]} onTaskUpdated={apply} notify={() => {}} onClose={() => window.returned.push("single")} />;
}

function Fixture() {
  // 「退出再打开」：卸掉整个单飞验收台再装回来（宿主手上的任务也回到初始那一份）。
  const [mount, setMount] = useState(0);
  window.remountSingle = () => setMount((value) => value + 1);
  return <AuthContext.Provider value={{ state: { mode: "single", user: null, needsSetup: false }, refresh: async () => {} }}>
    <div data-host="single" style={{ display: "flex", flexDirection: "column", height: 420 }}><Single key={mount} /></div>
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
