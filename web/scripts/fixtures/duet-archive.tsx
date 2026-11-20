import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Session, Task } from "@navi/shared";
import { DuetView } from "../../src/duet/DuetView.tsx";
import "../../src/styles/global.css";

const params = new URLSearchParams(location.search);
let current = {
  id: "duet-archive", projectId: "fixture", title: "讨论归档后保持只读", body: "讨论最稳妥的交付方案。",
  mode: "duet", status: params.get("status") ?? "awaiting_review", stage: null,
  archived: params.get("archived") !== "0", createdAt: "2026-11-20T01:00:00.000Z", updatedAt: "2026-11-20T01:00:00.000Z",
  labels: [], dependsOn: [], resumeDependsOn: [], agentType: "codex", useWorktree: false,
} as Task;
const mutations: { path: string; body: unknown }[] = [];
let renderMutations = () => {};
const linked = { ...current, id: "linked", title: "已经派出的落实任务", mode: "single", originTaskId: current.id } as Task;
const sessions = ["A", "B"].map((voice) => ({
  id: voice, taskId: current.id, role: `voice${voice}`, agentType: "codex", startedAt: current.createdAt,
  transcriptPath: `/isolated/${voice}.jsonl`,
})) as Session[];
window.fetch = async (input, init) => {
  const path = new URL(String(input), location.origin).pathname;
  const method = init?.method ?? "GET";
  if (method !== "GET") {
    mutations.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    renderMutations();
  }
  let value: unknown = [];
  let status = 200;
  if (path.endsWith("/duet")) value = [{
    type: "duet.gate", taskId: current.id, gate: "G1", version: 2, open: true, consensus: false,
    conclusionA: "先修共用冻结门禁，再验证所有入口。", conclusionB: "保留已有结论和关联任务，只冻结写操作。",
  }];
  else if (path.endsWith("/sessions")) value = sessions;
  else if (path === `/api/tasks/${current.id}`) value = current;
  else if (path === "/api/tasks" && method === "POST") value = { ...linked, id: `created-${mutations.length}` };
  else if (path.endsWith("/gate") || path.endsWith("/run")) value = {};
  else if (path.endsWith("/schedule")) value = null;
  else if (path.endsWith("/actions")) { value = { error: "isolated read-only fixture" }; status = 404; }
  else if (path.includes("accept-gate")) value = { command: null, run: null, occupied: false };
  else if (path.endsWith("/agents")) value = [{ id: "codex", name: "Codex", agentType: "codex", enabled: true, available: true }];
  else { value = { error: "隔离夹具未提供此只读接口" }; status = 404; }
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
};

function Fixture() {
  const [task, setTask] = useState(current);
  const [posts, setPosts] = useState(mutations.length);
  const [notice, setNotice] = useState("");
  renderMutations = () => setPosts(mutations.length);
  const update = (next: Task) => { current = next; setTask(next); };
  return <main style={{ maxWidth: 1000, margin: "0 auto" }}>
    <nav aria-label="隔离验证">
      <button onClick={() => update({ ...task, archived: !task.archived })}>切换归档</button>
      <output data-testid="mutations">{posts}</output>
      <output data-testid="notice">{notice}</output>
    </nav>
    <DuetView task={task} allTasks={params.has("linked") ? [task, linked] : [task]}
      onTaskUpdated={update} onTaskCreated={() => {}} onTaskDeleted={() => {}}
      onSelectTask={(next) => setNotice(`打开：${next.title}`)} notify={setNotice} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
