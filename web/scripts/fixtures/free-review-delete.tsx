import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FreeReviewDialog } from "../../src/free-workflow/FreeReviewDialog.tsx";
import type { FreeWorkflowApiState } from "../../src/lib/api.ts";
import "../../src/styles/global.css";

// 派审对话框本体，连着一份「本任务已经预约了 reviewer-2」的状态：删掉它时确认框要多说
// 一句「预约会一并取消」，删别人时不该说。审查者清单、删除请求都由测试那边 route 掉。
const BASE: FreeWorkflowApiState = {
  taskId: "task-1",
  selectedReviewerId: "reviewer-2",
  stateVersion: 1,
  workspaceHead: "abcdef1234567890",
  workspaceDirty: false,
  reviewReservation: {
    armed: true,
    reviewerId: "reviewer-2",
    checkMode: "logic",
    retryLimit: 1,
    note: null,
    override: null,
    runId: null,
  },
  reviewTurn: false,
  preview: { running: false, starting: false, hasLog: false, url: null, port: null, command: null, startedAt: null },
  executions: [],
  reviews: [],
};

// `?state=late`：挂载时父层那条 GET 还在飞，state 先是 null，之后才由测试放进来。
const lateState = new URLSearchParams(location.search).get("state") === "late";

function Fixture() {
  const [state, setState] = useState<FreeWorkflowApiState | null>(lateState ? null : BASE);
  const [notices, setNotices] = useState<string[]>([]);
  const [closed, setClosed] = useState(false);
  // 稳定引用：notify 每次渲染都换一个新函数的话，对话框那条「读审查者」的 effect 会被
  // 它带着反复重跑，响应乱序那一类问题会被这种额外重跑意外盖住，测不出来。
  const notify = useCallback((message: string) => setNotices((current) => [...current, message]), []);

  // 测试拿它模拟生产里那条 `task.review` → 重读状态的链路：对话框开着的时候远端状态会变。
  useEffect(() => {
    Object.assign(window as unknown as Record<string, unknown>, {
      freeReviewFixture: {
        arrive: () => setState(BASE),
        // 服务端删掉被预约引用的审查者之后会做的事：清选中项、撤预约。
        cancelReservation: () => setState((current) => (current ? {
          ...current,
          stateVersion: current.stateVersion + 1,
          selectedReviewerId: null,
          reviewReservation: {
            armed: false, reviewerId: null, checkMode: null, retryLimit: null, note: null, override: null, runId: null,
          },
        } : current)),
      },
    });
  }, []);

  return (
    <main style={{ padding: 20 }}>
      {!closed && (
        <FreeReviewDialog
          taskId={BASE.taskId}
          state={state}
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
