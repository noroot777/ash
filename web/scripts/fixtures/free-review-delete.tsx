import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FreeReviewDialog } from "../../src/free-workflow/FreeReviewDialog.tsx";
import type { FreeWorkflowApiState } from "../../src/lib/api.ts";
import "../../src/styles/global.css";

// 派审对话框本体 + 一个会变的「当前任务」。真实容器（FreeWorkflowToolbar / Inspector /
// TaskDetail）都不按 task.id 重建这个组件，所以浏览器后退换任务时，它拿到的就是一对
// 新的 (taskId, state) —— 这里照着那条链路摆，让测试能驱动它。
const COMMON = {
  stateVersion: 1,
  workspaceHead: "abcdef1234567890",
  workspaceDirty: false,
  reviewTurn: false,
  preview: { running: false, starting: false, hasLog: false, url: null, port: null, command: null, startedAt: null },
  executions: [],
  reviews: [],
} as const;

const STATE_A: FreeWorkflowApiState = {
  ...COMMON,
  taskId: "task-a",
  selectedReviewerId: "reviewer-2",
  reviewReservation: {
    armed: true, reviewerId: "reviewer-2", checkMode: "logic", retryLimit: 1, note: null, override: null, runId: null,
  },
};

const STATE_B: FreeWorkflowApiState = {
  ...COMMON,
  taskId: "task-b",
  selectedReviewerId: "reviewer-3",
  reviewReservation: {
    armed: true, reviewerId: "reviewer-3", checkMode: "syntax", retryLimit: 3, note: "任务 B 自己的附言", override: null, runId: null,
  },
};

// `?state=late`：挂载时父层那条 GET 还在飞，state 先是 null，之后才由测试放进来。
const lateState = new URLSearchParams(location.search).get("state") === "late";

function Fixture() {
  const [task, setTask] = useState<{ id: string; state: FreeWorkflowApiState | null }>(
    lateState ? { id: "task-a", state: null } : { id: "task-a", state: STATE_A },
  );
  const [notices, setNotices] = useState<string[]>([]);
  const [closed, setClosed] = useState(false);
  // 稳定引用：notify 每次渲染都换一个新函数的话，对话框里那两条 effect 会被它带着反复
  // 重跑，响应乱序那一类问题会被这种额外重跑意外盖住，测不出来。
  const notify = useCallback((message: string) => setNotices((current) => [...current, message]), []);

  // 测试拿它模拟生产里那条 `task.review` → 重读状态的链路，以及后退换任务。
  useEffect(() => {
    Object.assign(window as unknown as Record<string, unknown>, {
      freeReviewFixture: {
        arrive: () => setTask({ id: "task-a", state: STATE_A }),
        // 服务端删掉被预约引用的审查者之后会做的事：清选中项、撤预约、状态修订号 +1。
        cancelReservation: () => setTask((current) => (current.state ? { ...current, state: {
          ...current.state,
          stateVersion: current.state.stateVersion + 1,
          selectedReviewerId: null,
          reviewReservation: {
            armed: false, reviewerId: null, checkMode: null, retryLimit: null, note: null, override: null, runId: null,
          },
        } } : current)),
        // 任意一次「任务状态变了」（预览起停、审查推进…）：只把修订号 +1。
        bumpState: () => setTask((current) => (current.state
          ? { ...current, state: { ...current.state, stateVersion: current.state.stateVersion + 1 } }
          : current)),
        // 浏览器后退到另一个任务：容器不重建组件，只换 props。
        switchTask: () => setTask({ id: "task-b", state: STATE_B }),
      },
    });
  }, []);

  return (
    <main style={{ padding: 20 }}>
      <p data-testid="current-task">{task.id}</p>
      {!closed && (
        <FreeReviewDialog
          taskId={task.id}
          state={task.state}
          reservationMode={false}
          onChanged={() => {}}
          onClose={() => setClosed(true)}
          notify={notify}
        />
      )}
      {closed && <p data-testid="closed">对话框已关闭</p>}
      <ul data-testid="notices" style={{ position: "fixed", right: 8, bottom: 8, margin: 0, listStyle: "none", font: "11px var(--font)" }}>
        {notices.map((notice, index) => <li key={index}>{notice}</li>)}
      </ul>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
