import { StrictMode, useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Group, GroupMode, ProjectView, Task, TaskListItem, TaskMode } from "@ash/shared";
import { TaskComposerPanel } from "../../src/composer/TaskComposerPanel.tsx";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import { mergeCreatedTask, mergeTaskSnapshot } from "../../src/workspace/createdTaskMerge.ts";
import "../../src/styles/global.css";

// 「创建并排队」在途提交期间删除刚建任务的竞态夹具(第 7 轮审查):挂的是生产
// TaskComposerPanel,任务列表接线照抄 WorkspaceShell——createTask 先查本页删除
// 记录再走 mergeCreatedTask 并自动选中;deleteTask 记录 id 并移除行;成员同步走
// mergeTaskSnapshot。测试脚本扣住建队响应,期间模拟 SSE 送达新任务、再删除它,
// 放行旧响应后断言既不回插也不自动选中。
const project: ProjectView = {
  id: "p1",
  name: "ash",
  repoPath: "/tmp/ash",
  workflowId: null,
  useWorktreeDefault: false,
  createdAt: "2026-08-28T00:00:00.000Z",
  health: { exists: true, isRepo: true },
} as unknown as ProjectView;

const listTask = (id: string, title: string, extra: Partial<TaskListItem> = {}): TaskListItem => ({
  id,
  title,
  projectId: "p1",
  parentId: null,
  archived: false,
  mode: "single",
  groupId: null,
  queueId: null,
  queuePosition: null,
  status: "backlog",
  updatedAt: "2026-10-08T07:00:00.000Z",
  ...extra,
} as unknown as TaskListItem);

function Ash() {
  const [mode, setMode] = useState<TaskMode>("single");
  const [tasks, setTasks] = useState<TaskListItem[]>([listTask("t-backlog", "存量待办任务")]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  // 真实工作区里创建完面板就收起来,再开是新的一份;用 key 复现,否则 busy 挂住测不了第二条。
  const [round, setRound] = useState(0);
  const notify = useCallback((message: string) => setNotices((current) => [...current, message]), []);

  // ↓ 与 WorkspaceShell 相同的三件:删除记录、createTask 守卫、成员同步。
  const deletedTaskIds = useRef(new Set<string>());
  const deleteTask = (deletedId: string) => {
    deletedTaskIds.current.add(deletedId);
    setTasks((current) => current.filter((task) => task.id !== deletedId));
    setSelectedId((current) => (current === deletedId ? null : current));
  };
  const createTask = (task: Task) => {
    if (deletedTaskIds.current.has(task.id)) return;
    setTasks((current) => mergeCreatedTask(current, task));
    setSelectedId(task.id);
  };
  const applyTaskSnapshots = (snapshots: Task[]) => {
    setTasks((current) => snapshots.reduce(mergeTaskSnapshot, current));
  };
  // SSE task.created 送达路径(行先于在途响应出现在列表里)。
  const sseUpsert = (task: TaskListItem) => {
    setTasks((current) => current.some((row) => row.id === task.id)
      ? current.map((row) => (row.id === task.id ? task : row))
      : [task, ...current]);
  };

  return (
    <div style={{ display: "flex", height: "100vh", flexDirection: "column" }}>
      <TaskComposerPanel
        key={round}
        project={project}
        groups={[] as Group[]}
        tasks={tasks}
        mode={mode}
        onModeChange={setMode}
        onCancel={() => {}}
        onCreated={(task: Task) => { createTask(task); setRound((current) => current + 1); }}
        onTasksSynced={applyTaskSnapshots}
        onCreateGroup={async (name: string, groupMode: GroupMode) => ({
          id: "g1", projectId: project.id, name, mode: groupMode, createdAt: "2026-08-28T00:00:00.000Z",
        })}
        onProjectUpdated={() => {}}
        notify={notify}
      />
      <button type="button" data-testid="sse-create-task-1" onClick={() => {
        sseUpsert(listTask("task-1", "审查7-删除本次新建任务", { updatedAt: "2026-10-08T07:00:01.000Z" }));
      }}>SSE:task-1 已创建</button>
      <button type="button" data-testid="delete-task-1" onClick={() => deleteTask("task-1")}>删除task-1</button>
      <span data-testid="selected">{selectedId ?? "无"}</span>
      <ul data-testid="rows">
        {tasks.map((task) => <li key={task.id}>{`${task.id}:${task.queueId ?? "独立"}:${task.queuePosition ?? "-"}`}</li>)}
      </ul>
      <ul data-testid="notices">{notices.map((item, index) => <li key={index}>{`提示：${item}`}</li>)}</ul>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DraftProvider>
      <Ash />
    </DraftProvider>
  </StrictMode>,
);
