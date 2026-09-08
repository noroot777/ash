import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { api } from "../../src/lib/api.ts";
import { BranchAcceptancePanel } from "../../src/review/BranchAcceptancePanel.tsx";
import { AcceptanceControls } from "../../src/team/TeamReviewWorkspace.tsx";
import "../../src/styles/global.css";

function Fixture() {
  const [task, setTask] = useState<Task | null>(null);
  const [notice, setNotice] = useState("");
  const taskId = new URLSearchParams(location.search).get("task") || "case1-parent";
  useEffect(() => { void api.task(taskId).then(setTask); }, [taskId]);
  if (!task) return <p>读取测试任务…</p>;
  return <main style={{ maxWidth: 920, padding: 32, margin: "auto" }}>
    <h1>父子任务验收验证</h1><p>独立临时仓库与数据库中的测试任务</p>
    <nav style={{ display: "flex", gap: 16, marginBottom: 24 }}>
      {["case1-parent", "case1-child", "case2-child"].map(id => <a key={id} href={`?task=${id}`}>{id}</a>)}
    </nav>
    <h2>{task.title}</h2>
    <AcceptanceControls task={task} onTaskUpdated={setTask} notify={setNotice} />
    <BranchAcceptancePanel task={task} notify={setNotice} onTaskUpdated={setTask} />
    <p role="status">{notice}</p>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
