import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task, TaskListItem } from "@ash/shared";
import { TaskInspector } from "../../src/task-detail/TaskInspector.tsx";
import { mergeTaskSnapshot } from "../../src/workspace/createdTaskMerge.ts";
import "../../src/styles/global.css";

// 真实 Inspector 回调链的竞态夹具(第 6 轮审查):挂的是生产 TaskInspector,
// 接线照抄 WorkspaceShell/TaskDetail——快照走 applyTaskSnapshots(mergeTaskSnapshot
// 按 updatedAt 合并、缺行不插入),SSE 走无条件 updateTask。测试脚本扣住 insert
// 响应,在途期间送达更晚的移出/删除,再放行旧响应,断言不被反转。
const T0 = "2026-10-08T06:00:00.000Z";

const row = (id: string, title: string, extra: Partial<TaskListItem>): TaskListItem => ({
  id,
  title,
  body: title,
  projectId: "p1",
  parentId: null,
  archived: false,
  mode: "single",
  groupId: null,
  queueId: null,
  queuePosition: null,
  status: "backlog",
  agentType: "claude",
  executorId: null,
  model: null,
  reasoningEffort: null,
  labels: [],
  createdAt: T0,
  updatedAt: T0,
  ...extra,
} as unknown as TaskListItem);

const initialTasks: TaskListItem[] = [
  row("t-prev", "前驱任务A", { queueId: "q1", queuePosition: 0 }),
  row("t-b", "队列成员B", { queueId: "q1", queuePosition: 1 }),
  row("t-k1", "主体K1", {}),
  row("t-k2", "主体K2", {}),
];

function Ash() {
  const [tasks, setTasks] = useState<TaskListItem[]>(initialTasks);
  const [subjectId, setSubjectId] = useState("t-k1");
  const [notices, setNotices] = useState<string[]>([]);
  const [refreshFallbacks, setRefreshFallbacks] = useState(0);
  const notify = useCallback((message: string) => setNotices((current) => [...current, message]), []);

  // WorkspaceShell.applyTaskSnapshots 同款:按 updatedAt 合并、缺行不插入。
  const applyTaskSnapshots = useCallback((snapshots: Task[]) => {
    setTasks((current) => snapshots.reduce(mergeTaskSnapshot, current));
  }, []);
  // WorkspaceShell.updateTask 同款(SSE 送达路径):无条件替换。
  const updateTask = useCallback((updated: TaskListItem) => {
    setTasks((current) => current.some((task) => task.id === updated.id)
      ? current.map((task) => (task.id === updated.id ? updated : task))
      : [updated, ...current]);
  }, []);

  const subject = tasks.find((task) => task.id === subjectId) ?? null;
  return (
    <div style={{ display: "flex", height: "100vh", gap: 16 }}>
      <div style={{ width: 360, overflow: "auto" }}>
        {subject && (
          <TaskInspector
            task={subject as Task}
            groups={[]}
            sessions={[]}
            allTasks={tasks}
            followUps={[]}
            onOpenTask={() => {}}
            onOpenReview={() => {}}
            onPatch={async () => {}}
            // TaskDetail 同款:带参走按版本合并,无参是兜底刷新(这里只计数)。
            onQueueChanged={(updatedTask) => {
              if (updatedTask) applyTaskSnapshots([updatedTask]);
              else setRefreshFallbacks((current) => current + 1);
            }}
            onTasksSynced={applyTaskSnapshots}
            notify={notify}
          />
        )}
      </div>
      <div>
        <button type="button" data-testid="pick-k2" onClick={() => setSubjectId("t-k2")}>切到K2</button>
        {/* 模拟 SSE 送达「K2 已移出队列」(服务端事件,时间比在途响应晚) */}
        <button type="button" data-testid="sse-remove-k2" onClick={() => {
          const k2 = tasks.find((task) => task.id === "t-k2");
          if (k2) updateTask({ ...k2, queueId: null, queuePosition: null, updatedAt: "2026-10-08T06:00:09.000Z" } as TaskListItem);
        }}>SSE:移出K2</button>
        {/* 模拟本页删除成员 B(行直接消失,和真实删除后的列表一致) */}
        <button type="button" data-testid="delete-b" onClick={() => setTasks((current) => current.filter((task) => task.id !== "t-b"))}>删除B</button>
        <span data-testid="refresh-fallbacks">{refreshFallbacks}</span>
        <ul data-testid="rows">
          {tasks.map((task) => (
            <li key={task.id}>{`${task.id}:${task.queueId ?? "独立"}:${task.queuePosition ?? "-"}:${task.updatedAt}`}</li>
          ))}
        </ul>
        <ul data-testid="notices">{notices.map((item, index) => <li key={index}>{`提示：${item}`}</li>)}</ul>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Ash />
  </StrictMode>,
);
