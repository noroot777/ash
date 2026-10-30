import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ReclaimTurnSwitch } from "../../src/task-detail/ReclaimTurnSwitch.tsx";
import { useRejectionNotices } from "../../src/task-detail/useRejectionNotices.ts";
import "../../src/styles/global.css";

// 「回合占位占着不动」那条救援路的真实表面:上面是任务历史里的那几条记录(含一条服务端
// 都读不准的),下面是用户唯一按得动的那个开关。两样都走生产组件和生产 api 出口 ——
// 请求由测试用 page.route 拦下,所以凭据头、凭据轮换、403 恢复路径全是真的。
//
// `?task=` 选哪一套固定数据,`?second=` 再摆一个**另一个任务**的开关(测试按它分档,见
// test-turn-remedy-dom.mjs):凭据是整页共享的一份,两个表面轮换不同步就是「按了第一个
// 之后第二个按不动」。
const params = new URLSearchParams(location.search);
const taskId = params.get("task") ?? "t-stale";
const second = params.get("second");

function Stage({ id }: { id: string }) {
  const { items, remedy } = useRejectionNotices(id);
  return (
    <section data-stage={id}>
      <h2 style={{ font: "var(--font-h3)" }}>{id}</h2>
      <ul className="turn-remedy-notices">
        {items.map((item) => <li key={item.id} data-notice-id={item.id}>{item.text}</li>)}
      </ul>
      {remedy === "reclaim-turn" && <ReclaimTurnSwitch taskId={id} />}
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main style={{ maxWidth: 760, padding: 24, margin: "auto", background: "var(--bg)", minHeight: "100vh" }}>
      <h1 style={{ font: "var(--font-h2)" }}>任务历史</h1>
      <Stage id={taskId} />
      {second && <Stage id={second} />}
    </main>
  </StrictMode>,
);
