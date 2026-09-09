import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { TaskListItem } from "@ash/shared";
import { OriginTaskBar } from "../../src/components/TaskOrigin.tsx";
import { TaskRow } from "../../src/workspace/TaskTreeRows.tsx";
import "../../src/styles/global.css";
import "../../src/styles/workspace.css";
import "../../src/styles/task-tree.css";

function Fixture() {
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [selected, setSelected] = useState<TaskListItem | null>(null);
  useEffect(() => { void fetch("/api/tasks?projectId=project").then(r => r.json()).then(setTasks); }, []);
  return <main style={{ padding: 32 }}>
    <h1>任务创建来源验证</h1><p>独立临时数据库中的真实创建记录</p>
    <div style={{ display: "flex", gap: 24 }}>
      <aside className="workspace-sidebar" style={{ width: 360 }}>
        {tasks.map(task => <TaskRow key={task.id} task={task} allTasks={tasks} selectedTaskId={selected?.id || null} indicatorForTask={() => null} onTask={setSelected} />)}
      </aside>
      <section style={{ flex: 1, minWidth: 0 }}>
        {selected && <><h2>{selected.title}</h2><OriginTaskBar task={selected} allTasks={tasks} onOpen={id => setSelected(tasks.find(t => t.id === id) || null)} /></>}
      </section>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
