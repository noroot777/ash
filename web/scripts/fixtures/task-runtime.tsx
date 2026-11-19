import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { Globe, Info, TerminalWindow } from "@phosphor-icons/react";
import { InspectorHost, surfaceTabWhenUsed, type InspectorDescriptor } from "../../src/inspector/index.ts";
import { useTaskRuntime, type TaskRuntime } from "../../src/task-runtime/useTaskRuntime.ts";
import { ServiceInspector } from "../../src/task-runtime/ServiceInspector.tsx";
import { BrowserInspector } from "../../src/task-runtime/TaskBrowserPane.tsx";
import { RuntimeAutoOpen } from "../../src/task-runtime/RuntimeAutoOpen.tsx";
import "../../src/styles/global.css";

// 任务页右栏里「服务」「浏览器」那两格的真实接法（taskInspectors.tsx + useTaskInspectorStack.ts），
// 外面只留一格「信息」占位，会话换成一段静态文字。
const DESCRIPTORS: readonly InspectorDescriptor<TaskRuntime>[] = [
  { id: "info", title: "信息", icon: <Info size={14} />, defaultOpen: true, render: () => <p className="insp-pane">任务信息</p> },
  { id: "service", title: "服务", icon: <TerminalWindow size={14} />, render: (runtime) => <ServiceInspector runtime={runtime} /> },
  { id: "browser", title: "浏览器", icon: <Globe size={14} />, wide: true, render: (runtime) => <BrowserInspector runtime={runtime} /> },
];

function Fixture() {
  const runtime = useTaskRuntime("runtime");
  const { service, browser } = runtime.state;
  const descriptors = useMemo(() => surfaceTabWhenUsed(
    surfaceTabWhenUsed(DESCRIPTORS, "service", !!service, () => ({ dot: service?.running ? "run" : "has" })),
    "browser", !!browser || runtime.serviceReady, () => ({ dot: browser?.status === "ready" ? "run" : browser ? "has" : null }),
  ), [service, browser, runtime.serviceReady]);
  return <InspectorHost contextKey="task:runtime-fixture" descriptors={descriptors} context={runtime}>
    {({ openTab }) => <main style={{ display: "flex", flex: 1, minWidth: 0, flexDirection: "column", color: "var(--ink)", background: "var(--panel)" }}>
      <header style={{ padding: "14px 20px", borderBottom: "0.5px solid var(--line)", fontSize: 14 }}>额度控制台 · 浏览器验证</header>
      <section style={{ flex: 1, padding: "32px", overflow: "auto" }} aria-label="任务会话">
        <p style={{ color: "var(--faint)", fontSize: 12 }}>Codex</p>
        <h1 style={{ fontSize: 22, marginBlock: 12 }}>页面已完成，正在验证</h1>
        <p style={{ color: "var(--muted)", lineHeight: 1.9 }}>我已启动任务工作区的服务。接下来核对输入、保存与手机布局。</p>
      </section>
      <div style={{ padding: "16px 20px" }}><textarea aria-label="回复任务" placeholder="继续这个任务…" style={{ width: "100%", resize: "none", padding: 12, border: "1px solid var(--line)", borderRadius: 12 }} /></div>
      <RuntimeAutoOpen taskId="runtime" browser={browser} openTab={openTab} />
    </main>}
  </InspectorHost>;
}

createRoot(document.getElementById("root")!).render(<div style={{ height: "100dvh", display: "flex", background: "var(--canvas)" }}><Fixture /></div>);
