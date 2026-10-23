import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { AcceptGateCard } from "../../src/review/AcceptGateCard.tsx";
import "../../src/styles/global.css";

// 验收前置命令那张卡的测试舞台。只挂这一张卡：它自己拉状态、自己判要不要出现，
// 把整个验收台搬进来只会把真正要验的东西埋在一堆无关请求里。
const task = (over: Partial<Task>): Task => ({
  id: "gate-task",
  projectId: "proj-1",
  title: "门禁卡",
  body: "",
  mode: "single",
  status: "done",
  stage: "verified",
  labels: [],
  dependsOn: [],
  resumeDependsOn: [],
  agentType: "claude",
  useWorktree: true,
  workflowMode: "free",
  createdAt: "2026-10-23T00:00:00.000Z",
  updatedAt: "2026-10-23T00:00:00.000Z",
  ...over,
} as unknown as Task);

function Fixture() {
  const params = new URLSearchParams(location.search);
  const [notice, setNotice] = useState("");
  const [intent, setIntent] = useState("");
  return <main style={{ maxWidth: 760, padding: 24, margin: "auto" }}>
    <h1>验收前置命令卡</h1>
    <AcceptGateCard
      task={task({ stage: params.get("stage") ?? "verified" } as Partial<Task>)}
      notify={setNotice}
      onIntent={(value) => setIntent(value)}
      disabled={params.get("disabled") === "1"}
    />
    <p role="status" aria-label="操作结果">{notice}</p>
    <output aria-label="验收意图">{intent}</output>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
