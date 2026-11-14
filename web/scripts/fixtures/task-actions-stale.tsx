import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { useTaskActions } from "../../src/lib/useTaskActions.ts";

// 「此刻能做什么」的失效 → 重取那一条链路，整条都是真的：真 EventSource 连测试进程里的真 SSE，
// 真 GET /api/tasks/:id/actions，真 useTaskActions。屏幕上只摆每个表面读到的那一步。
function Surface({ taskId, name }: { taskId: string; name: string }) {
  const actions = useTaskActions(taskId);
  return <li data-surface={name} data-primary={actions?.primary?.kind ?? "none"}>{name}</li>;
}

function Board() {
  // 同一个任务挂两个表面（头 + 信息格那种）：只该发一次请求。t-2 可以关掉，关着时它的失效不该换来请求。
  const [second, setSecond] = useState(true);
  return (
    <main>
      <button type="button" onClick={() => setSecond((value) => !value)}>toggle t-2</button>
      <ul>
        <Surface taskId="t-1" name="t-1-head" />
        <Surface taskId="t-1" name="t-1-info" />
        {second && <Surface taskId="t-2" name="t-2" />}
      </ul>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Board /></StrictMode>);
