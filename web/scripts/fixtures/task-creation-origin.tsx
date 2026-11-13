import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task, TaskListItem } from "@ash/shared";
import { TaskHeader } from "../../src/task-detail/TaskHeader.tsx";
import { TaskRow } from "../../src/workspace/TaskTreeRows.tsx";
import "../../src/styles/global.css";
import "../../src/styles/workspace.css";
import "../../src/styles/task-tree.css";
import "../../src/styles/task-detail.css";

function Fixture() {
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [selected, setSelected] = useState<TaskListItem | null>(null);
  useEffect(() => { void fetch("/api/tasks?projectId=project").then(r => r.json()).then(setTasks); }, []);
  const noop = async () => {};
  return <main style={{ padding: 32 }}>
    <h1>任务创建来源验证</h1><p>独立临时数据库中的真实创建记录</p>
    <div style={{ display: "flex", gap: 24 }}>
      <aside className="workspace-sidebar" style={{ width: 360 }}>
        {tasks.map(task => <TaskRow key={task.id} task={task} allTasks={tasks} selectedTaskId={selected?.id || null} lookForTask={() => ({ indicator: null, mark: null, say: "", bucket: "done", word: null, detail: null })} onTask={setSelected} />)}
      </aside>
      <section style={{ flex: 1, minWidth: 0 }}>
        {selected && <>
          <h2>{selected.title}</h2>
          {/* 真的挂详情页顶栏：谁开的、从哪来都收在标题前那颗来源图标上，挪走了这里会立刻挂。 */}
          <TaskHeader
            task={{ ...selected, body: "" } as Task}
            actions={null}
            allTasks={tasks}
            conversationMarkdown=""
            busy={false}
            refreshing={false}
            reviewOpen={false}
            onTitle={noop}
            onTogglePin={noop}
            onPrimary={() => {}}
            onRequeue={() => {}}
            onArchive={() => {}}
            onRefresh={() => {}}
            onReview={() => {}}
            onDelete={() => {}}
            onOpenTask={id => setSelected(tasks.find(t => t.id === id) || null)}
            notify={() => {}}
          />
        </>}
      </section>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
