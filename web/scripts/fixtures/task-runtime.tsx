import { createRoot } from "react-dom/client";
import { TaskRuntimeWorkspace } from "../../src/task-runtime/TaskRuntimeWorkspace.tsx";
import "../../src/styles/global.css";

createRoot(document.getElementById("root")!).render(<main style={{ height: "100dvh", display: "flex", flexDirection: "column", color: "var(--ink)", background: "var(--canvas)" }}>
  <header style={{ padding: "14px 20px", borderBottom: "1px solid var(--line)", fontSize: 14 }}>额度控制台 · 浏览器验证</header>
  <TaskRuntimeWorkspace taskId="runtime" notify={() => {}}>
    <section style={{ flex: 1, padding: "32px", overflow: "auto" }} aria-label="任务会话">
      <p style={{ color: "var(--faint)", fontSize: 12 }}>Codex</p>
      <h1 style={{ fontSize: 22, marginBlock: 12 }}>页面已完成，正在验证</h1>
      <p style={{ color: "var(--muted)", lineHeight: 1.9 }}>我已启动任务工作区的服务。接下来核对输入、保存与手机布局。</p>
      <p style={{ marginTop: 30, fontSize: 13 }}>浏览器中的内容与智能体操作保持一致。</p>
    </section>
    <div style={{ padding: "16px 20px", borderTop: "1px solid var(--line)" }}><textarea aria-label="回复任务" placeholder="继续这个任务…" style={{ width: "100%", resize: "none", padding: 12, border: "1px solid var(--line)", borderRadius: 12 }} /></div>
  </TaskRuntimeWorkspace>
</main>);
