import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task, TaskListItem } from "@navi/shared";
import { TaskInspector } from "../../src/task-detail/TaskInspector.tsx";
import { PrerequisiteWait } from "../../src/task-detail/PrerequisiteWait.tsx";
import { taskLook } from "../../src/lib/taskLook.ts";
import { mergeTaskSnapshot } from "../../src/workspace/createdTaskMerge.ts";
import "../../src/styles/global.css";

// 「信息」格加减前置（task-detail/info/InfoPrerequisites.tsx）：挂生产 TaskInspector，快照照 WorkspaceShell 的
// applyTaskSnapshots 合并；旁边摆会话里那一行「在等谁」和侧栏的画法，看加减之后三处是不是跟着变。
const T0 = "2026-11-15T06:00:00.000Z";
const row = (id: string, title: string, extra: Partial<Task>): Task => ({
  id, title, body: title, projectId: "p1", parentId: null, archived: false, mode: "single", groupId: null,
  queueId: null, queuePosition: null, status: "backlog", agentType: "claude", executorId: null, model: null,
  reasoningEffort: null, labels: [], createdAt: T0, updatedAt: T0, backgroundRevision: 0, ...extra,
} as unknown as Task);

const initialTasks: Task[] = [
  row("t-sub", "下游任务", {
    backgroundRevision: 1,
    prerequisites: {
      prerequisites: [{ taskId: "t-a", title: "前置甲", step: "running", round: null, movedOn: false }],
      dependents: [], waiting: true, blocked: null, launched: false,
    },
  }),
  row("t-started", "已开工的任务", {
    status: "running",
    backgroundRevision: 1,
    prerequisites: {
      prerequisites: [{ taskId: "t-a", title: "前置甲", step: "settled", round: null, movedOn: false }],
      dependents: [], waiting: false, blocked: null, launched: true,
    },
  }),
  row("t-a", "前置甲", { status: "running" }),
  row("t-b", "前置乙", { status: "running" }),
];

function Navi() {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [subjectId, setSubjectId] = useState("t-sub");
  const [notices, setNotices] = useState<string[]>([]);
  const notify = useCallback((message: string) => setNotices((current) => [...current, message]), []);
  const applyTaskSnapshots = useCallback((snapshots: Task[]) => {
    setTasks((current) => snapshots.reduce(mergeTaskSnapshot, current));
  }, []);
  const subject = tasks.find((task) => task.id === subjectId)!;
  return (
    <div style={{ display: "flex", height: "100vh", gap: 16 }}>
      <div style={{ width: 360, overflow: "auto" }}>
        <TaskInspector task={subject} groups={[]} sessions={[]} allTasks={tasks as TaskListItem[]} followUps={[]}
          onOpenTask={() => {}} onOpenReview={() => {}} onPatch={async () => {}} onQueueChanged={() => {}}
          onTasksSynced={applyTaskSnapshots} notify={notify} />
      </div>
      <div>
        <button type="button" data-testid="pick-started" onClick={() => setSubjectId("t-started")}>切到已开工的</button>
        <div data-testid="wait">{subject.prerequisites && <PrerequisiteWait view={subject.prerequisites} />}</div>
        <span data-testid="look">{taskLook(subject as TaskListItem).indicator}</span>
        <ul data-testid="notices">{notices.map((item, index) => <li key={index}>{`提示：${item}`}</li>)}</ul>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Navi /></StrictMode>);
