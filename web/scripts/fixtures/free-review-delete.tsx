import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { FreeReviewDialog } from "../../src/free-workflow/FreeReviewDialog.tsx";
import type { FreeWorkflowApiState } from "../../src/lib/api.ts";
import "../../src/styles/global.css";

// 派审对话框本体，连着一份「本任务已经预约了 reviewer-2」的状态：删掉它时确认框要多说
// 一句「预约会一并取消」，删别人时不该说。审查者清单、删除请求都由测试那边 route 掉。
const STATE: FreeWorkflowApiState = {
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

function Fixture() {
  const [notices, setNotices] = useState<string[]>([]);
  const [closed, setClosed] = useState(false);

  return (
    <main style={{ padding: 20 }}>
      {!closed && (
        <FreeReviewDialog
          taskId={STATE.taskId}
          state={STATE}
          reservationMode={false}
          onChanged={() => {}}
          onClose={() => setClosed(true)}
          notify={(message) => setNotices((current) => [...current, message])}
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
