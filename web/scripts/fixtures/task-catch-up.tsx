import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { useTasks } from "../../src/lib/useTasks.ts";

// 任务列表的**静默追平**那一条链路,整条都是真的:真 EventSource 连真 SSE(测试进程里
// 的 vite 中间件,不是 page.route 伪造的一次性响应),真 GET /api/tasks,真 useTasks。
// 屏幕上只摆追平结果本身 —— 哪些任务在列、谁在跑哨兵、连没连上。
function Board() {
  const { tasks, connected } = useTasks("p1");
  return (
    <main data-connected={String(connected)} style={{ padding: 24, font: "14px ui-sans-serif" }}>
      <ul data-rows={String(tasks.length)}>
        {tasks.map((task) => (
          <li key={task.id} data-task={task.id} data-monitor={String(task.monitorRunning)}>
            {task.title}
          </li>
        ))}
      </ul>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Board /></StrictMode>);
