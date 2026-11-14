import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Task, TaskListItem } from "@ash/shared";
import { AuthContext } from "../../src/auth/authContext.ts";
import { AcceptanceControls } from "../../src/acceptance/AcceptanceControls.tsx";
import { TaskReviewWorkspace } from "../../src/review/TaskReviewWorkspace.tsx";
import { TeamReviewWorkspace } from "../../src/team/TeamReviewWorkspace.tsx";
import "../../src/styles/global.css";

// 验收台（AcceptanceControls）的几何舞台：一行决定、一列前提。宿主都用真组件挂出来——
// 单任务验收台、团队验收台（顶栏 + 一个独立执行者的记录头）、讨论结论那一条、工作流侧栏那道
// 「等我点头」，再加一张「合并预览冲突」的单任务验收台量 diff 从哪儿开始。
//
// 这一页不答任何请求：/api/** 全由测试脚本用 page.route 答（数据、哪几行该红都在那边），
// 这里只摆任务和宿主的外壳。判据与来由见 test-acceptance-host-layout.mjs。

// SSE 在这一屏里只负责「有变化就重读」，舞台上不发事件，挂一个空壳免得它反复重连。
window.EventSource = class { close() {} addEventListener() {} removeEventListener() {} } as unknown as typeof EventSource;

const base = {
  projectId: "proj-1", body: "", labels: [], dependsOn: [], resumeDependsOn: [], agentType: "claude",
  mode: "single", status: "done", stage: "awaiting_acceptance", useWorktree: true, workflowMode: null, workflow: null,
  parentId: null, archived: false, mergeTargetBranch: "main", worktreeBase: "main",
  createdAt: "2026-11-02T01:03:00.000Z", updatedAt: "2026-11-02T01:24:00.000Z",
};
const task = (id: string, title: string, extra: Record<string, unknown> = {}) =>
  ({ ...base, id, title, ...extra }) as unknown as Task;

const single = task("single-task", "验收台换成一行决定");
const conflict = task("conflict-task", "合并预览撞冲突");
const lead = task("team-lead", "团队重写验收台", { mode: "team" });
const workers = [
  task("shared-worker", "共享执行者 · 改样式", { parentId: "team-lead", useWorktree: false, status: "running", stage: null }),
  task("indie-worker", "独立执行者 · 修复记录头的布局，让很长的标题也只占一行", { parentId: "team-lead", status: "done", stage: null }),
] as TaskListItem[];
const duet = task("duet-task", "讨论验收台怎么摆", { mode: "duet" });
const stacked = task("wf-task", "工作流任务");

const noop = () => {};
const noIndicator = () => null;

function Frame({ host, height, children }: { host: string; height: number; children: ReactNode }) {
  return <div data-host={host} style={{ display: "flex", flexDirection: "column", height, marginBottom: 16, background: "var(--canvas)" }}>{children}</div>;
}

function Fixture() {
  return <AuthContext.Provider value={{ state: { mode: "single", user: null, needsSetup: false }, refresh: async () => {} }}>
    <Frame host="single" height={560}>
      <TaskReviewWorkspace task={single} allTasks={[single]} onTaskUpdated={noop} notify={noop} onClose={noop} onOpenReview={noop} />
    </Frame>
    <Frame host="team" height={760}>
      <TeamReviewWorkspace lead={lead} workers={workers} onTaskUpdated={noop} indicatorForTask={noIndicator} onReadTask={noop} notify={noop} />
    </Frame>
    {/* DuetView 底部那一条：讨论结束后结论条与「交给团队」那一栏并排。 */}
    <div data-host="duet" style={{ marginBottom: 16 }}>
      <div className="duet-terminal-handoff">
        <AcceptanceControls className="duet-terminal-acceptance" task={duet} onTaskUpdated={noop} notify={noop}
          lead={<b className="acc-title">讨论结论</b>} />
      </div>
    </div>
    {/* WorkflowInspector 人工关口那一格：右侧栏 380px 宽。 */}
    <aside data-host="stacked" className="inspector-host" style={{ width: 380, maxWidth: "100%", padding: 12, marginBottom: 16 }}>
      <div className="wf-vgate">
        <AcceptanceControls className="acc-stacked" task={stacked} onTaskUpdated={noop} notify={noop} />
        <p className="wf-vnote">在这儿按，和在审查页里按是同一件事。</p>
      </div>
    </aside>
    <Frame host="conflict" height={560}>
      <TaskReviewWorkspace task={conflict} allTasks={[conflict]} onTaskUpdated={noop} notify={noop} onClose={noop} onOpenReview={noop} />
    </Frame>
  </AuthContext.Provider>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
