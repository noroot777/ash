import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { RemoteTaskDetail } from "../../src/remote-task/RemoteTaskDetail.tsx";
import { useRemoteReturns } from "../../src/remote-task/useRemoteReturns.ts";
import { useToast, WorkspaceToast } from "../../src/workspace/WorkspaceToast.tsx";
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
  const { toasts, notify, dismiss } = useToast();
  const [selected, setSelected] = useState(archive);
  const [visible, setVisible] = useState(true);
  const returns = useRemoteReturns(notify);
  const onLocalOwnership = useCallback((task: Task) => setLocal(task), []);
  const select = (task: Task) => {
    setSelected(task);
    setLocal(null);
    setVisible(true);
  };

  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      <nav>
        <button type="button" onClick={() => select({ ...archive, id: "another-task", title: "另一条任务" })}>切换任务</button>
        <button type="button" onClick={() => select(archive)}>切回原任务</button>
        <button type="button" onClick={() => setVisible((current) => !current)}>{visible ? "离开详情" : "重新打开详情"}</button>
        <button type="button" onClick={() => select({ ...archive, handoff: { ...archive.handoff!, transferId: "next-transfer" } })}>同任务再次接力</button>
        <button type="button" onClick={() => notify("预览命令缺失，请配置启动命令", { sticky: true })}>模拟预览失败</button>
      </nav>
      {visible && (local ? <p role="status">本机任务：{local.title}</p> : (
        <RemoteTaskDetail archive={selected} target={target} returns={returns} onLocalOwnership={onLocalOwnership} notify={notify} />
      ))}
      <WorkspaceToast toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Demo /></StrictMode>);
