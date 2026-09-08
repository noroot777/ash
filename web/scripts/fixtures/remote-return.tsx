import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { RemoteTaskDetail } from "../../src/remote-task/RemoteTaskDetail.tsx";
import "../../src/styles/global.css";

const target = { name: "远程服务器", url: "http://remote.test:4317" };
const archive: Task = {
  id: "remote-return-task",
  projectId: "project",
  groupId: null,
  parentId: null,
  title: "查看理赔审核提案",
  body: "",
  mode: "single",
  status: "canceled",
  labels: [],
  dependsOn: [],
  resumeDependsOn: [],
  createdAt: "2026-09-08T09:00:00.000Z",
  updatedAt: "2026-09-08T09:00:00.000Z",
  startedAt: null,
  endedAt: null,
  archived: false,
  handoff: {
    direction: "out",
    peerUrl: target.url,
    peerName: target.name,
    peerTaskId: "remote-return-task",
    transferId: "original-transfer",
    at: "2026-09-08T09:00:00.000Z",
    sessions: 0,
    git: "none",
  },
};

function Demo() {
  const [local, setLocal] = useState<Task | null>(null);
  const [toast, setToast] = useState("");
  const [selected, setSelected] = useState(archive);
  const onLocalOwnership = useCallback((task: Task) => setLocal(task), []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2_500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      <button type="button" onClick={() => setSelected({ ...archive, id: "another-task", title: "另一条任务" })}>
        切换任务
      </button>
      {local ? <p role="status">本机任务：{local.title}</p> : (
        <RemoteTaskDetail archive={selected} target={target} onLocalOwnership={onLocalOwnership} notify={setToast} />
      )}
      <div className={`workspace-toast${toast ? " is-visible" : ""}`}>{toast}</div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Demo /></StrictMode>);
