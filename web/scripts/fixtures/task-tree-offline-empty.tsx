import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectView, Task } from "@ash/shared";
import { TaskTree } from "../../src/workspace/TaskTree.tsx";
import type { SidebarSpread } from "../../src/workspace/useSidebarSpread.ts";
import "../../src/styles/global.css";
import "../../src/styles/workspace.css";
import "../../src/styles/project-switcher.css";
import "../../src/styles/task-tree.css";
import "../../src/styles/task-mode.css";

// 任务模式里唯一的候选是「接力出去、持有机这一轮联系不上」的那种任务：它退回本机冻住的
// 状态（canceled）后一行都不剩，这时候**空态和离线提示必须同时在**。回归的那个 bug：
// 空态有两份拷贝，其中一份是提前 return，把离线提示整个绕过去了 —— 最需要解释
//「接力那条怎么没了」的时刻，屏幕上只剩一句「没有在跑、等你答复或待验收的任务」。

const at = new Date().toISOString();

const project: ProjectView = {
  id: "p1",
  name: "ash",
  repoPath: "/tmp/ash",
  workflowId: null,
  createdAt: at,
  health: { exists: true, isRepo: true },
};

const handedOut: Task = {
  id: "gone",
  projectId: project.id,
  groupId: null,
  parentId: null,
  title: "接力出去的唯一一条",
  body: "",
  mode: "single",
  // 导出前会先停掉任务，所以本机这一行冻在 canceled 上 —— 问不到实时状态时就是它。
  status: "canceled",
  stage: null,
  labels: [],
  dependsOn: [],
  resumeDependsOn: [],
  createdAt: at,
  updatedAt: at,
  handoff: {
    direction: "out",
    peerUrl: "http://peer.test",
    peerName: "mac-mini",
    peerTaskId: "gone",
    at,
    sessions: 1,
    git: "none",
  },
};

const idleSpread: SidebarSpread = {
  open: false,
  laidOut: false,
  filter: "all",
  setFilter: () => {},
  followUps: new Map(),
  bodies: new Map(),
  loaded: new Set(),
  toggle: () => {},
  close: () => {},
};

function Ash() {
  const spread = useMemo(() => idleSpread, []);
  return (
    <main style={{ width: 320, minHeight: 480, background: "var(--canvas, #f4f4f5)" }}>
      <TaskTree
        projects={[project]}
        currentProjectId={project.id}
        scope={{ kind: "tasks" }}
        tasks={[handedOut]}
        selectedTaskId={null}
        selectedRemoteTaskId={null}
        spread={spread}
        onTask={() => {}}
        onRemoteTask={() => {}}
        onTaskStarred={() => {}}
        onHandoffFinished={() => {}}
        outbound={{
          outboundCount: 1,
          offlinePeers: [{ url: "http://peer.test", name: "mac-mini", reason: "fetch failed" }],
          asked: true,
          refreshing: false,
          onRefresh: () => {},
        }}
        notify={() => {}}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Ash />
  </StrictMode>,
);
