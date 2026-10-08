import { StrictMode, useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Group, GroupMode, ProjectView, Task, TaskListItem, TaskMode } from "@ash/shared";
import { TaskComposerPanel } from "../../src/composer/TaskComposerPanel.tsx";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import { useTasks } from "../../src/lib/useTasks.ts";
import { mergeCreatedTask, mergeTaskSnapshot } from "../../src/workspace/createdTaskMerge.ts";
import "../../src/styles/global.css";

// 「创建并排队」在途提交期间删除刚建任务的竞态夹具(第 7、8、9 轮审查):挂的是生产
// TaskComposerPanel,任务列表状态用**真实 useTasks**(初始 GET、refetch 的权威删除
// 确认、共享失效记录 confirmedDeleteIds 全是生产代码);createTask/deleteTask 接线
// 照抄 WorkspaceShell,面板开合也照抄(开着/关着由状态控制,onCreated 只在
// ownsComposer 时收面板)。测试脚本扣住入队响应,期间:
//   A. 本页删除刚建任务(deleteTask 登记) —— 第 7 轮路径;
//   B. 另一页面删除:快照不含它,点「权威刷新」走真实 refetch 确认 —— 第 8 轮路径;
//   C. 删除后关掉面板、新开一份写新草稿 —— 第 9 轮路径:旧请求放行时新面板不得被
//      关、新草稿不得被清。
// 放行旧响应后断言既不回插也不自动选中;对照轮确认正常创建不受影响。
const project: ProjectView = {
  id: "p1",
  name: "ash",
  repoPath: "/tmp/ash",
  workflowId: null,
  useWorktreeDefault: false,
  createdAt: "2026-08-28T00:00:00.000Z",
  health: { exists: true, isRepo: true },
} as unknown as ProjectView;

function Ash() {
  const [mode, setMode] = useState<TaskMode>("single");
  const { tasks, setTasks, refetch, confirmedDeleteIds } = useTasks();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  // 面板开合照抄 WorkspaceShell 的 composer 状态:关了再开是新的一份(round 当 key)。
  const [composerOpen, setComposerOpen] = useState(true);
  const round = useRef(0);
  const openComposer = () => { round.current += 1; setComposerOpen(true); };
  const notify = useCallback((message: string) => setNotices((current) => [...current, message]), []);

  // ↓ 与 WorkspaceShell 相同的接线:createTask 守卫 + ownsComposer 分流、deleteTask 登记、成员同步。
  const deleteTask = (deletedId: string) => {
    confirmedDeleteIds.current.add(deletedId);
    setTasks((current) => current.filter((task) => task.id !== deletedId));
    setSelectedId((current) => (current === deletedId ? null : current));
  };
  const createTask = (task: Task, _noteIds: string[], ownsComposer: boolean) => {
    if (confirmedDeleteIds.current.has(task.id)) {
      if (ownsComposer) setComposerOpen(false);
      return;
    }
    setTasks((current) => mergeCreatedTask(current, task));
    setSelectedId(task.id);
    if (ownsComposer) setComposerOpen(false);
  };
  const applyTaskSnapshots = (snapshots: Task[]) => {
    setTasks((current) => snapshots.reduce(mergeTaskSnapshot, current));
  };
  // SSE task.created 送达路径(行先于在途响应出现在列表里;生产 upsert 同形)。
  const sseUpsert = (task: TaskListItem) => {
    setTasks((current) => current.some((row) => row.id === task.id)
      ? current.map((row) => (row.id === task.id ? task : row))
      : [task, ...current]);
  };
  const sseRow = (id: string, title: string): TaskListItem => ({
    id, title, projectId: "p1", parentId: null, archived: false, mode: "single", groupId: null,
    queueId: null, queuePosition: null, status: "backlog", updatedAt: "2026-10-08T07:00:01.000Z",
  } as unknown as TaskListItem);

  return (
    <div style={{ display: "flex", height: "100vh", flexDirection: "column" }}>
      {composerOpen && (
        <TaskComposerPanel
          key={round.current}
          project={project}
          groups={[] as Group[]}
          tasks={tasks}
          mode={mode}
          onModeChange={setMode}
          onCancel={() => setComposerOpen(false)}
          onCreated={createTask}
          onTasksSynced={applyTaskSnapshots}
          onCreateGroup={async (name: string, groupMode: GroupMode) => ({
            id: "g1", projectId: project.id, name, mode: groupMode, createdAt: "2026-08-28T00:00:00.000Z",
          })}
          onProjectUpdated={() => {}}
          notify={notify}
        />
      )}
      <button type="button" data-testid="open-composer" onClick={openComposer}>新建任务</button>
      <button type="button" data-testid="close-composer" onClick={() => setComposerOpen(false)}>关闭面板</button>
      <button type="button" data-testid="sse-create-task-1" onClick={() => sseUpsert(sseRow("task-1", "审查7-删除本次新建任务"))}>SSE:task-1 已创建</button>
      <button type="button" data-testid="sse-create-task-2" onClick={() => sseUpsert(sseRow("task-2", "审查8-跨页删除任务"))}>SSE:task-2 已创建</button>
      <button type="button" data-testid="sse-create-task-3" onClick={() => sseUpsert(sseRow("task-3", "审查9-删除后另写新草稿"))}>SSE:task-3 已创建</button>
      <button type="button" data-testid="sse-create-task-4" onClick={() => sseUpsert(sseRow("task-4", "审查9-建队分支删除后另写"))}>SSE:task-4 已创建</button>
      <button type="button" data-testid="delete-task-1" onClick={() => deleteTask("task-1")}>删除task-1</button>
      <button type="button" data-testid="delete-task-3" onClick={() => deleteTask("task-3")}>删除task-3</button>
      <button type="button" data-testid="delete-task-4" onClick={() => deleteTask("task-4")}>删除task-4</button>
      <button type="button" data-testid="refetch" onClick={() => void refetch({ silent: true })}>权威刷新</button>
      <span data-testid="composer-open">{composerOpen ? "开" : "关"}</span>
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
